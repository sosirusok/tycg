import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { db, fail, json, body, requireUser, limit, WITHDRAWN_NAME } from './http';
import { countFetch, currentMeter, localRequest, metered } from './meter';
import type { User } from '../shared/market';

// 웹 푸시 (WP64): payload-less pushes (RFC 8030) signed with VAPID (RFC 8292). A push carries no data;
// the service worker (public/sw.js) reads the member's newest unread 알림 or chat (GET
// notifications/latest) and shows it, so nothing private goes through the push services and no payload
// encryption is needed.
// - The keys are Worker secrets that deploy.yml creates once: VAPID_PRIVATE_KEY (a P-256 JWK),
//   VAPID_PUBLIC_KEY and VAPID_SUBJECT. Without them push is off: GET config gives no vapidPublicKey and
//   the app never offers '알림 켜기'.
// - Right after a request (ctx.waitUntil, at most 3 pushes): a chat message, a 제시 and its 수락 or 거절
//   to the other member, a 댓글 or 답글 to the post or parent author whose 알림 row was written.
// - The 알림 that reach many members at once (키워드, 구독, 조건, 매칭, 찜 가격 내림, 끌올 가능, 같은 매물,
//   the weekly 자동 끌올 check and the trial reminders) are queued by the notifications_push trigger
//   (0051_push.sql), one row per member, and tick B sends them (pushJob).

const HOUR = 3600000, DAY = 24 * HOUR;
// Pushes right after one request, pushes per tick B, and the devices kept per member (the newest).
export const PUSH_INLINE = 3, PUSH_PER_TICK = 20, PUSH_DEVICES = 3;
// The 5th failure in a row deletes a subscription; a 404 or 410 deletes it at once.
const FAIL_LIMIT = 5;
// Tick B's limits per run (worker/automation.ts): D1 calls, and D1 statements plus fetches.
const TICK_CALLS = 8, TICK_BUDGET = 45;
// An undelivered push is kept by the push service for a day. The JWT is valid for 12 hours (RFC 8292
// allows up to 24) and reused per push service until an hour before it ends.
const TTL_SECONDS = 86400, JWT_HOURS = 12;

const b64url = (bytes: Uint8Array) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));

// ---- Keys ----------------------------------------------------------------------------------------------

type Vapid = { jwk: JsonWebKey; publicKey: string; subject: string };
let parsed: { raw: string; vapid: Vapid | null } | null = null;
const COORD = /^[A-Za-z0-9_-]{43}$/;

// The keys, read once per isolate. The public key is always the private key's own (the 65-byte point of
// its x and y), so a VAPID_PUBLIC_KEY that does not match can never make browsers subscribe to a key the
// pushes are not signed with.
export function vapid(): Vapid | null {
    const e = env as Partial<Env>;
    const raw = [e.VAPID_PRIVATE_KEY, e.VAPID_PUBLIC_KEY, e.VAPID_SUBJECT].map(v => v ?? '').join('\n');
    if (parsed?.raw === raw) return parsed.vapid;
    let v: Vapid | null = null;
    if (e.VAPID_PRIVATE_KEY) {
        try {
            const k = JSON.parse(e.VAPID_PRIVATE_KEY);
            const subject = (e.VAPID_SUBJECT || '').trim();
            if (k?.kty === 'EC' && k.crv === 'P-256' && [k.d, k.x, k.y].every(c => typeof c === 'string' && COORD.test(c)) && /^(https:\/\/|mailto:)\S+$/.test(subject)) {
                const point = new Uint8Array(65);
                point[0] = 4;
                point.set(fromB64url(k.x), 1);
                point.set(fromB64url(k.y), 33);
                const publicKey = b64url(point);
                if (e.VAPID_PUBLIC_KEY && e.VAPID_PUBLIC_KEY.trim() !== publicKey) console.error('VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY; the private key\'s own public key is used');
                v = { jwk: { kty: 'EC', crv: 'P-256', d: k.d, x: k.x, y: k.y }, publicKey, subject };
            } else console.error('VAPID_PRIVATE_KEY or VAPID_SUBJECT is not usable; push is off');
        } catch { console.error('VAPID_PRIVATE_KEY is not a JSON key; push is off'); }
    }
    parsed = { raw, vapid: v };
    return v;
}

// For GET config: the key browsers subscribe with, or null while push is off.
export const vapidPublicKey = () => vapid()?.publicKey ?? null;

let signer: { publicKey: string; key: CryptoKey } | null = null;
const tokens = new Map<string, { header: string; until: number }>();

// 'vapid t=<JWT>, k=<public key>' for one push service (aud is its origin), ES256 signed with WebCrypto
// (the signature is r‖s, as JWS wants).
async function authorization(v: Vapid, origin: string, now: number) {
    const id = v.publicKey + ' ' + origin, hit = tokens.get(id);
    if (hit && hit.until > now) return hit.header;
    if (signer?.publicKey !== v.publicKey) signer = { publicKey: v.publicKey, key: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.' + part({ aud: origin, exp: Math.floor(now / 1000) + JWT_HOURS * 3600, sub: v.subject });
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.key, new TextEncoder().encode(unsigned)));
    const header = `vapid t=${unsigned}.${b64url(signature)}, k=${v.publicKey}`;
    if (tokens.size >= 50) tokens.clear();
    tokens.set(id, { header, until: now + (JWT_HOURS - 1) * HOUR });
    return header;
}

// ---- Sending -------------------------------------------------------------------------------------------

export type Sub = { id: number; user_id: string; endpoint: string; fail_count: number };
type Sent = { s: Sub; r: 'ok' | 'gone' | 'failed' };

// One empty POST. Redirects are not followed, so a push goes only to the address the browser gave.
async function send(v: Vapid, s: Sub, now: number): Promise<Sent> {
    try {
        const url = new URL(s.endpoint);
        const headers = { TTL: String(TTL_SECONDS), Authorization: await authorization(v, url.origin, now) };
        countFetch();
        const res = await fetch(url.href, { method: 'POST', headers, body: new Uint8Array(0), redirect: 'manual', signal: AbortSignal.timeout(10000) });
        await res.body?.cancel().catch(() => {});
        return { s, r: res.status === 404 || res.status === 410 ? 'gone' : res.ok ? 'ok' : 'failed' };
    } catch { return { s, r: 'failed' }; }
}

// At most 2 statements: failures count up and a success clears the count; then the rows the push service
// no longer knows (404, 410) and those at their 5th failure go.
function resultStatements(sent: Sent[]) {
    const ids = (f: (x: Sent) => boolean) => sent.filter(f).map(x => x.s.id);
    const failed = ids(x => x.r === 'failed'), healed = ids(x => x.r === 'ok' && x.s.fail_count > 0), gone = ids(x => x.r === 'gone');
    const out: D1PreparedStatement[] = [];
    if (failed.length || healed.length) out.push(db().prepare('UPDATE push_subscriptions SET fail_count=CASE WHEN id IN (SELECT value FROM json_each(?)) THEN fail_count+1 ELSE 0 END WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(failed), JSON.stringify([...failed, ...healed])));
    if (failed.length || gone.length) out.push(db().prepare(`DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?)) OR (id IN (SELECT value FROM json_each(?)) AND fail_count>=${FAIL_LIMIT})`)
        .bind(JSON.stringify(gone), JSON.stringify(failed)));
    return out;
}

// Sends, then one batch: `before` (tick B's queue rows) and the results.
async function sendAll(v: Vapid, subs: Sub[], now: number, before: D1PreparedStatement[] = []) {
    const sent = await Promise.all(subs.map(s => send(v, s, now)));
    const writes = [...before, ...resultStatements(sent)];
    if (writes.length) await db().batch(writes);
    return { pushed: sent.filter(x => x.r === 'ok').length, failed: sent.filter(x => x.r !== 'ok').length };
}

// ---- Right after a request -----------------------------------------------------------------------------

type Box = { users: string[]; known: Map<string, Sub[]> };
const outbox = new AsyncLocalStorage<Box>();

// Names a member who gets a push once this request has answered (handleApi runs the request inside
// withPushes). subs: the member's devices when the request's own batch already read them
// (pushSubsStatement), so the push needs no read of its own. Outside withPushes, or while push is off,
// it does nothing.
export function pushAfter(userId: string | null | undefined, subs?: Sub[]) {
    const box = outbox.getStore();
    if (!box || !userId) return;
    if (!box.users.includes(userId)) box.users.push(userId);
    if (subs) box.known.set(userId, subs);
}

// The member's newest devices, as pushAfter takes them, for a request's own batch (채팅 전송, WP69), read
// only when `guard` holds; null while push is off or outside withPushes.
export function pushSubsStatement(userId: string, guard = '1', args: unknown[] = []) {
    if (!vapid() || !outbox.getStore()) return null;
    return db().prepare(`SELECT id,user_id,endpoint,fail_count FROM push_subscriptions WHERE user_id=? AND ${guard} ORDER BY created_at DESC,id DESC LIMIT ${PUSH_INLINE}`).bind(userId, ...args);
}

// Runs the request; when it succeeded and named members, their newest devices get a push after the
// response (at most 3 pushes, taking each member's newest device first). With the test meter on, that
// work counts on a meter of its own, so the request's X-D1-Calls are the request's alone.
export async function withPushes(ctx: ExecutionContext | undefined, run: () => Promise<Response>) {
    if (!ctx || !vapid()) return run();
    const box: Box = { users: [], known: new Map() };
    const res = await outbox.run(box, run);
    if (box.users.length && res.status < 400) {
        const work = () => pushNow(box);
        ctx.waitUntil((currentMeter() ? metered(work) : work()).catch(e => console.error('Push failed', e instanceof Error ? e.message : 'unknown')));
    }
    return res;
}

async function pushNow(box: Box) {
    const v = vapid();
    if (!v) return;
    const unknown = box.users.filter(u => !box.known.has(u));
    const read = unknown.length ? (await db().prepare(`SELECT id,user_id,endpoint,fail_count FROM (SELECT s.id,s.user_id,s.endpoint,s.fail_count,s.created_at,
            ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.created_at DESC,s.id DESC) AS rn FROM push_subscriptions s WHERE s.user_id IN (SELECT value FROM json_each(?)))
        ORDER BY rn,created_at DESC LIMIT ${PUSH_INLINE}`).bind(JSON.stringify(unknown)).all<Sub>()).results : [];
    // Each member's newest device first, then their next ones, at most 3 in all.
    const lists = box.users.map(u => box.known.get(u) ?? read.filter(s => s.user_id === u));
    const subs: Sub[] = [];
    for (let rank = 0; subs.length < PUSH_INLINE && lists.some(l => l.length > rank); rank++) {
        for (const l of lists) if (l[rank] && subs.length < PUSH_INLINE) subs.push(l[rank]);
    }
    if (subs.length) await sendAll(v, subs, Date.now());
}

// ---- Tick B --------------------------------------------------------------------------------------------

// The queue (0051_push.sql: one row per member, oldest first): at most 20 members a tick, taken in order
// while their devices fit the tick's room (k: a member's devices, run: the devices so far). A row older
// than a day is taken without a push. One row per device of the members taken, and one row with no
// device for a member without any.
const PICK = `WITH q AS (SELECT p.id,p.user_id,CASE WHEN p.created_at>=? THEN (SELECT COUNT(*) FROM push_subscriptions s WHERE s.user_id=p.user_id) ELSE 0 END AS k
        FROM push_queue p ORDER BY p.id LIMIT ${PUSH_PER_TICK}),
    c AS (SELECT id,user_id,k,SUM(k) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS run FROM q)
    SELECT c.id AS qid,s.id,s.user_id,s.endpoint,s.fail_count FROM c LEFT JOIN push_subscriptions s ON s.user_id=c.user_id AND c.k>0 WHERE c.run<=? ORDER BY c.id,s.id`;

// Tick B's pushes, after its other work: one push per queued member (to each of their devices), at most
// 20 a tick, and only while the tick stays within 8 D1 calls and 45 statements plus fetches (scheduled
// runs always carry the meter, worker/index.ts); the rest wait for the next tick. An empty queue costs
// one statement. The members taken leave the queue in the results batch after the sends.
export async function pushJob(now: number) {
    const v = vapid();
    if (!v) return { push: 'off' };
    const m = currentMeter();
    const calls = m?.d1Calls ?? TICK_CALLS, used = m ? m.d1Statements + m.fetches : TICK_BUDGET;
    // Its own 2 calls and at most 4 statements: the pick, then the queue rows and the results.
    const room = Math.min(PUSH_PER_TICK, TICK_BUDGET - used - 4);
    if (calls + 2 > TICK_CALLS || room < 1) return { pushed: 0, held: true };
    const rows = (await db().prepare(PICK).bind(now - DAY, room).all<Sub & { qid: number }>()).results;
    if (!rows.length) return { pushed: 0 };
    const taken = db().prepare('DELETE FROM push_queue WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(rows.map(r => r.qid))]));
    return sendAll(v, rows.filter(r => r.id !== null), now, [taken]);
}

// ---- Routes --------------------------------------------------------------------------------------------

const KEY_TEXT = /^[A-Za-z0-9_-]+={0,2}$/;

// A push service on the public internet: https on the default port and a DNS name, never an address or a
// local name, so no member can point the Worker's POSTs at a private host. With PUSH_TEST=on, a local
// request may also use http://127.0.0.1 (the mock push service of tests/verify-push.mjs).
function endpointOf(raw: unknown, req: Request) {
    if (typeof raw !== 'string' || raw.length > 1000) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.username || u.password || u.hash) return null;
    const host = u.hostname.replace(/\.$/, '').toLowerCase();
    if (u.protocol === 'https:' && !u.port && host.includes('.') && !/^[\d.]+$/.test(host) && !host.startsWith('[') && !/(^|\.)(localhost|local|internal)$/.test(host)) return u.href;
    if (u.protocol === 'http:' && host === '127.0.0.1' && (env as Partial<Env>).PUSH_TEST === 'on' && localRequest(req)) return u.href;
    return null;
}

// POST push/subscribe {endpoint, keys: {p256dh, auth}}: this browser gets the member's pushes (a device
// that was another member's moves over); each member keeps the newest 3 devices.
// DELETE push/subscribe {endpoint}: the member's own row only (before 로그아웃).
export async function pushHandler(req: Request, p: string[]): Promise<Response | null> {
    if (p[1] !== 'subscribe' || p[2] || (req.method !== 'POST' && req.method !== 'DELETE')) return null;
    if (req.method === 'POST' && !vapid()) return null;
    const u = await requireUser(req);
    await limit('push:' + u.id, 30, 600000);
    const b = await body(req);
    if (req.method === 'DELETE') {
        if (typeof b.endpoint !== 'string' || b.endpoint.length > 1000) fail(400, '알림 주소를 확인해 주세요.');
        await db().prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').bind(b.endpoint, u.id).run();
        return json({ ok: true });
    }
    const endpoint = endpointOf(b.endpoint, req);
    const p256dh = b.keys?.p256dh, auth = b.keys?.auth;
    if (!endpoint || typeof p256dh !== 'string' || p256dh.length < 80 || p256dh.length > 100 || !KEY_TEXT.test(p256dh)
        || typeof auth !== 'string' || auth.length < 16 || auth.length > 32 || !KEY_TEXT.test(auth)) fail(400, '알림 주소를 확인해 주세요.');
    const now = Date.now();
    await db().batch([
        db().prepare(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,fail_count,created_at) VALUES(?,?,?,?,0,?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,fail_count=0,created_at=excluded.created_at`).bind(u.id, endpoint, p256dh, auth, now),
        db().prepare(`DELETE FROM push_subscriptions WHERE user_id=? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ${PUSH_DEVICES})`).bind(u.id, u.id),
    ]);
    return json({ ok: true });
}

// ---- What the service worker shows ---------------------------------------------------------------------

export type LatestAlert = { id: number; type: string; ref: string; post_id: number | null; text: string; created_at: number; post_title: string | null };
export type PushView = { title: string; body: string; url: string; tag: string; id?: number };
const SITE_NAME = '좀비고 거래소', ALERTS_PAGE = '/me/alerts';

// Where a tap goes, as the 알림함 opens the row (src/pages/Alerts.tsx); 알림 the 알림함 shows best (새 글 counts,
// the trial's apply button) open the 알림함 itself. A post the member can no longer see opens the 알림함.
function alertUrl(a: LatestAlert) {
    const post = a.post_id !== null && a.post_title !== null ? a.post_id : null;
    switch (a.type) {
        case 'application': return '/me/applications';
        case 'follow': return '/profile/' + encodeURIComponent(a.ref);
        case 'auto_stale': return '/me/posts?stale=1';
        case 'auto_paused': return a.ref === 'reply' ? '/chat' : '/me/auto';
        case 'comment': case 'reply': return post === null ? ALERTS_PAGE : `/posts/${post}#comments`;
        case 'keyword': case 'board': case 'condition': case 'match': case 'grade_end': return ALERTS_PAGE;
        default: return post === null ? ALERTS_PAGE : '/posts/' + post;
    }
}

function chatPreview(m: { body: string | null; type: string; attachments: string | null }) {
    if (m.type === 'offer') return '가격 제시';
    const text = (m.body || '').replace(/\s+/g, ' ').trim();
    if (!text) return m.attachments && m.attachments !== '[]' ? '사진' : '새 채팅';
    return text.length > 100 ? text.slice(0, 99) + '…' : text;
}

// The newer of the member's newest unread 알림 (`alert`) and newest unread chat message. The tag is the
// chat or the 알림 row, so the service worker replaces a notification still on screen without a second
// sound. A 알림 opened elsewhere than the 알림함 carries its id, so a tap marks it read as the 알림함 would.
export async function latestPush(u: User, alert: LatestAlert | null): Promise<PushView | null> {
    const chat = await db().prepare(`SELECT x.cid,m.body,m.type,m.attachments,m.created_at,s.nickname,s.deleted_at FROM (SELECT id AS cid FROM conversations WHERE user_a=? AND a_unread>0
            UNION ALL SELECT id FROM conversations WHERE user_b=? AND b_unread>0) x
        JOIN messages m ON m.id=(SELECT MAX(mm.id) FROM messages mm WHERE mm.conversation_id=x.cid AND mm.sender_id!=? AND mm.read_at IS NULL AND mm.type!='listing')
        JOIN users s ON s.id=m.sender_id ORDER BY m.created_at DESC,m.id DESC LIMIT 1`).bind(u.id, u.id, u.id)
        .first<{ cid: string; body: string | null; type: string; attachments: string | null; created_at: number; nickname: string | null; deleted_at: number | null }>();
    if (chat && (!alert || chat.created_at >= alert.created_at)) {
        return { title: chat.deleted_at ? WITHDRAWN_NAME : chat.nickname || SITE_NAME, body: chatPreview(chat), url: '/chat/' + chat.cid, tag: 'chat-' + chat.cid };
    }
    if (!alert) return null;
    const url = alertUrl(alert);
    return { title: SITE_NAME, body: alert.text, url, tag: 'alert-' + alert.id, ...url === ALERTS_PAGE ? {} : { id: alert.id } };
}
