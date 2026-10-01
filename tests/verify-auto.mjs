import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 자동 끌올 (WP52) on the strict 8791 server (no assets, --test-scheduled, TEST_HOOKS=on, READ_BUDGET=on):
// grants and the trial turn it on, the page-1 skip, one post per run, the 2-끌올 reserve, the 09:00-02:00
// window, the per-tab hourly cap, paying members before trial members, the away / reply / 7-day pauses,
// the 5-post limit of 프리미엄, an ended grade, the daily cap, the '끌올 가능' 알림 (tick B) and the
// per-run budget. Ticks run at chosen times: TEST_HOOKS=on makes the tick take the test event's
// scheduledTime (?time=) as now. Every scenario looks only at its own members (the others are switched
// off for it) and its own boards, and runs at least an hour after the previous one on the same tab.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, KST = 9 * HOUR;
const GRANT_LINE = '자동 끌올이 켜졌습니다. 설정은 내 거래의 자동화 탭에 있습니다.';
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

// Every write (and every request, which may clear a pause) drops the cached snapshot below.
let snapshot = null;
function sql(command) {
    if (!/^\s*SELECT/i.test(command)) snapshot = null;
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    const all = JSON.parse(out.slice(out.indexOf('[')));
    return all[all.length - 1].results;
}

async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}

function client(ip = 'local') {
    let cookie = '';
    const c = async (path, method = 'GET', data) => {
        snapshot = null;
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'cf-connecting-ip': ip, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
    return c;
}

let regs = 0;
async function register(name) {
    const c = client(`10.52.${Math.floor(regs / 200)}.${1 + (regs++ % 200)}`);
    const r = await c('auth/register', 'POST', { username: `au_${run}_${name}`.slice(0, 24), password, nickname: `자동${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// Tick A ('*/10 * * * *') or tick B at a chosen time; returns the run's meter.
async function tick(at, cron = '*/10 * * * *') {
    snapshot = null;
    const r = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}&time=${at}`, () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    assert.equal(r.status, 200, `tick at ${new Date(at).toISOString()} answered ${r.status}`);
    return JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || '{}');
}

// Tomorrow on the Korean clock: every scenario runs between 09:00 and 23:50 KST of that day (and once at
// 03:00), so members who signed in a moment ago are never away for 3 days, and posts written now are
// past every same-post gap.
const day1 = Date.now() - ((Date.now() + KST) % DAY) + DAY;
const at = (h, m = 0) => day1 + h * HOUR + m * MIN;

// An earlier run that stopped half way may have left events and posts at tomorrow's times.
sql(`DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'trial-ip:%' OR key LIKE 'post:%'; DELETE FROM settings WHERE key IN ('sys:auto_count','sys:auto_bump_cap');
    DELETE FROM post_events WHERE created_at>${Date.now() + 2 * HOUR}; UPDATE posts SET bumped_at=MIN(created_at,${Date.now()}) WHERE bumped_at>${Date.now() + 2 * HOUR};
    DELETE FROM posts WHERE title_key LIKE 'qafill%' OR title_key LIKE 'qabulk%' OR title_key LIKE 'qae2%'`);

const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade, plan = 'permanent') => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan })).status, 201, `manager grants ${grade} ${plan}`);

let n = 0;
const post = (c, extra = {}) => c('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 자동 ${run} ${++n}`, body: '자동 끌올 검증', price: 10000, tags: [], images: [], details: {}, ...extra });
async function created(c, extra) {
    const r = await post(c, extra);
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
// One read for every member of this run (wrangler d1 execute takes about 1.7 s a call): the automation
// row, the auto events, the listed posts and the wallet. Reused until the next write, request or tick.
function snap(c) {
    snapshot ??= new Map(sql(`SELECT u.id,(SELECT json_object('bump_on',bump_on,'bump_new',bump_new,'bump_next_at',bump_next_at,'pause_reason',pause_reason,'paused_at',paused_at,'auto_today',auto_today) FROM automation WHERE user_id=u.id) AS a,
            (SELECT json_group_array(json_object('post_id',post_id,'created_at',created_at)) FROM (SELECT post_id,created_at FROM post_events WHERE user_id=u.id AND auto=1 ORDER BY id)) AS e,
            (SELECT json_group_array(post_id) FROM (SELECT post_id FROM post_auto WHERE user_id=u.id AND bump=1 ORDER BY post_id)) AS l,u.bump_tokens,u.bump_at
        FROM users u WHERE u.username LIKE 'au\\_${run}\\_%' ESCAPE '\\'`).map(r => [r.id, { auto: JSON.parse(r.a || 'null'), events: JSON.parse(r.e), listed: JSON.parse(r.l), wallet: { bump_tokens: r.bump_tokens, bump_at: r.bump_at } }]));
    return snapshot.get(c.user.id);
}
const autoRow = c => snap(c).auto;
const listed = c => snap(c).listed;
const autoEvents = c => snap(c).events;
const tokens = c => snap(c).wallet;
const bumpedAt = id => sql(`SELECT bumped_at FROM posts WHERE id=${id}`)[0].bumped_at;
const ids = list => list.map(c => `'${c.user.id}'`).join(',');
// Only these members are looked at by the next ticks (every other automation row is switched off).
const only = (...members) => sql(`UPDATE automation SET bump_on=CASE WHEN user_id IN (${ids(members)}) THEN 1 ELSE 0 END WHERE bump_on=1 OR user_id IN (${ids(members)})`);
const dueAt = (c, t = 1) => `UPDATE automation SET bump_next_at=${t},pause_reason='',paused_at=NULL WHERE user_id='${c.user.id}';`;

// The seeder writes the board fillers (16 newer posts push a post off page 1 and hold the top 5).
const seeder = await register('seed');
const fill = (kind, category, t, count = 16) => `INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,created_at,updated_at,touched_at,bumped_at,title_key)
    SELECT '${seeder.user.id}','${kind}','[QA] fill ${run} '||value,'filler',10000,'open','${category}','fixed',${Date.now()},${Date.now()},${Date.now()},${t},'qafill${run}${kind}${category}'||value
    FROM json_each('${JSON.stringify(Array.from({ length: count }, (_, i) => i))}');`;
// Moves posts into a board at a time (one statement).
const place = (postIds, kind, category, t) => `UPDATE posts SET kind='${kind}',category='${category}',bumped_at=${t} WHERE id IN (${postIds.join(',')});`;

// 1. Grants and the trial turn it on.
const plus = await register('plus');
const plusPosts = [await created(plus), await created(plus)];
await grant(plus, 'plus');
const pRow = autoRow(plus);
equal([pRow.bump_on, pRow.bump_new], [1, 0], 'a 플러스 grant makes the automation row: 자동 끌올 on, 새 글 자동 포함 off');
equal(listed(plus), [plusPosts[1]], 'and lists the most recently bumped open post');
const plusChat = (await plus('chats')).data.chats.find(ch => ch.partner_id === 'manager');
const plusLines = plusChat ? (await plus(`chats/${plusChat.id}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body) : [];
check(plusLines.some(b => b.endsWith('\n' + GRANT_LINE)), `the grant chat line says 자동 끌올 is on (${JSON.stringify(plusLines)})`);

const elite = await register('elite');
const elitePosts = [await created(elite), await created(elite), await created(elite)];
await grant(elite, 'elite');
equal([autoRow(elite).bump_new, listed(elite)], [1, elitePosts], 'an 엘리트 grant turns 새 글 자동 포함 on and lists every open post');
const eliteNew = await created(elite);
check(listed(elite).includes(eliteNew), 'a new 엘리트 post joins the list');

// The trial (the window opens for these sign-ups only).
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - HOUR}',0),('sys:trial_end','${Date.now() + HOUR}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const trial = await register('trial');
const trial2 = await register('trial2');
sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
check(trial.user.grade === 'plus' && trial.user.grade_trial, 'a sign-up in the window gets the 플러스 체험');
equal(autoRow(trial)?.bump_on, 1, 'the trial makes the automation row, on');
const trialPost = await created(trial);
equal(listed(trial), [trialPost], 'the trial member’s first post is listed at once');
const trialChats = (await trial('chats')).data.chats;
equal(trialChats.length, 0, 'the trial sends no chat line');

// The 자동화 tab and the post switch.
const mine = (await manager('me/automation')).data;
equal([mine.bumpOn, mine.slots], [false, null], "the manager's row is made on first use, off, for every post");
const state = (await plus('me/automation')).data;
equal([state.bumpOn, state.slots, state.everyMin, state.listed, state.trial], [true, 1, 240, 1, false], 'GET me/automation: on, 1 post, every 4 hours');
equal((await trial('me/automation')).data.trial, true, 'the trial member is told 체험 members go after paying members');
const normal = await register('normal');
const normalPost = await created(normal);
refused(await normal(`posts/${normalPost}/auto`, 'PUT', { bump: true }), 403, '자동 끌올은 플러스부터 가능합니다.', '일반 cannot list a post');
refused(await normal('me/automation'), 403, '자동 끌올은 플러스부터 가능합니다.', '일반 has no 자동화 tab');
const moved = await plus(`posts/${plusPosts[0]}/auto`, 'PUT', { bump: true });
equal([moved.status, moved.data.moved, listed(plus)], [200, true, [plusPosts[0]]], '플러스 switching another post on moves its one listed post');
equal((await plus('posts/' + plusPosts[0])).data.post.auto.bump, true, 'GET posts/:id tells the author the switch is on');
equal((await plus(`posts?author=${plus.user.id}&counts=1`)).data.posts.find(p => p.id === plusPosts[0]).auto, true, '내 글 rows carry the 자동 chip');

const premium = await register('premium');
const premiumPosts = [];
for (let i = 0; i < 6; i++) premiumPosts.push(await created(premium));
await grant(premium, 'premium');
equal(listed(premium).length, 5, 'a 프리미엄 grant lists the 5 newest open posts');
const outside = premiumPosts.find(id => !listed(premium).includes(id)), inside = listed(premium)[0];
const sixth = await premium(`posts/${outside}/auto`, 'PUT', { bump: true });
refused(sixth, 409, '자동 끌올은 글 5개까지입니다.', 'a 6th 프리미엄 post is refused');
equal(sixth.data.listed.length, 5, 'the 409 lists the 5 posts for the 뺄 글 선택 sheet');
equal((await premium(`posts/${inside}/auto`, 'PUT', { bump: false })).status, 200, 'one post is taken off');
equal((await premium(`posts/${outside}/auto`, 'PUT', { bump: true })).data.bump, true, 'then the other one goes on');

// 2. Page 1: a listed post on page 1 spends nothing; once 16 newer posts push it off, one tick bumps it.
only(plus);
sql(fill('sell', 'goods_coupon', at(9, 5)) + place([plusPosts[0]], 'sell', 'goods_coupon', at(9, 6)) + dueAt(plus));
const before = tokens(plus);
await tick(at(9, 10));
equal([bumpedAt(plusPosts[0]), tokens(plus), autoEvents(plus).length, autoRow(plus).pause_reason], [at(9, 6), before, 0, 'idle'], 'on page 1 the tick spends nothing (쉬는 중)');
sql(fill('sell', 'goods_coupon', at(9, 7)) + dueAt(plus));
await tick(at(9, 50));
equal(bumpedAt(plusPosts[0]), at(9, 50), 'after 16 newer posts the tick bumps it');
equal(tokens(plus).bump_tokens, 4, 'it spends 1 끌올 (5 → 4)');
equal(autoEvents(plus).map(e => e.post_id), [plusPosts[0]], 'one auto=1 event');
equal([autoRow(plus).bump_next_at, autoRow(plus).auto_today], [at(9, 50) + 240 * MIN, 1], 'the next run is 4 hours later');

// 3. One post per run: 엘리트 with 20 listed posts off page 1 and 8 끌올.
const elite2 = await register('elite2');
await grant(elite2, 'elite');
sql(`INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,created_at,updated_at,touched_at,bumped_at,title_key)
    SELECT '${elite2.user.id}','buy','[QA] e2 ${run} '||value,'e2',10000,'open','goods_coupon','fixed',${Date.now() - DAY},${Date.now()},${Date.now()},${at(10, 0)}-value*60000,'qae2${run}'||value FROM json_each('${JSON.stringify(Array.from({ length: 20 }, (_, i) => i))}');
    INSERT INTO post_auto(post_id,user_id,bump) SELECT id,author_id,1 FROM posts WHERE author_id='${elite2.user.id}';
    UPDATE users SET bump_tokens=8,bump_at=${at(11)} WHERE id='${elite2.user.id}';` + fill('buy', 'goods_coupon', at(10, 30)) + dueAt(elite2));
only(elite2);
equal(listed(elite2).length, 20, 'the 엘리트 member lists 20 posts');
await tick(at(11));
equal(autoEvents(elite2).length, 1, 'one tick bumps exactly 1 of the 20 posts');
equal(sql(`SELECT title FROM posts WHERE id=${autoEvents(elite2)[0].post_id}`)[0].title, `[QA] e2 ${run} 19`, 'the oldest-bumped one');
await tick(at(11, 10));
equal(autoEvents(elite2).length, 1, 'the next tick 10 minutes later bumps none (every 30 minutes)');
await tick(at(11, 30));
equal([autoEvents(elite2).length, autoRow(elite2).pause_reason], [1, 'idle'], '30 minutes later its bumped post still holds the board’s top 5: none');
sql(fill('buy', 'goods_coupon', at(11, 35), 5) + dueAt(elite2));
await tick(at(11, 40));
equal(autoEvents(elite2).length, 2, 'once 5 newer posts push it out of the top 5 the next one goes');

// 4. The reserve: 2 끌올 stay for manual use.
const plus2 = await register('plus2');
const p2 = [await created(plus2), await created(plus2), await created(plus2)];
await grant(plus2, 'plus');
sql(fill('exchange', 'clan', at(11, 50)) + place(p2, 'sell', 'clan', at(11, 40)) + place([p2[0]], 'exchange', 'clan', at(11, 40))
    + `UPDATE users SET bump_tokens=2,bump_at=${at(12) - MIN} WHERE id='${plus2.user.id}';` + dueAt(plus2));
only(plus2);
await tick(at(12));
equal([autoEvents(plus2).length, autoRow(plus2).pause_reason], [0, 'wallet'], 'with 2 끌올 left the tick bumps nothing');
sql(`UPDATE users SET bump_tokens=2,bump_at=${Date.now() - MIN} WHERE id='${plus2.user.id}'; UPDATE posts SET created_at=created_at-${4 * HOUR},bumped_at=${Date.now() - 4 * HOUR} WHERE id IN (${p2.join(',')});`);
equal((await plus2(`posts/${p2[1]}/bump`, 'POST', {})).data.bumpTokens, 1, 'a manual 끌올 still works (2 → 1)');
equal((await plus2(`posts/${p2[2]}/bump`, 'POST', {})).data.bumpTokens, 0, 'and another (1 → 0)');
refused(await plus2(`posts/${p2[0]}/bump`, 'POST', {}), 429, '끌올이 없습니다.', 'then the wallet is empty');

// 5. The window: nothing at 03:00 KST; the same member is bumped at 13:00.
const plus3 = await register('plus3');
const p3 = await created(plus3);
await grant(plus3, 'plus');
sql(fill('exchange', 'account', at(2, 30)) + place([p3], 'exchange', 'account', at(2)) + dueAt(plus3));
only(plus3);
await tick(at(3));
equal([autoEvents(plus3).length, bumpedAt(p3)], [0, at(2)], 'a tick at 03:00 KST bumps nothing');
await tick(at(13));
equal(autoEvents(plus3).length, 1, 'the same member is bumped at 13:00');

// 6. The per-tab hourly cap: 2 auto bumps and no other activity → none; 9 new posts → a 3rd, not a 4th.
const m6 = await register('m6'), m6b = await register('m6b');
const p6 = await created(m6), p6b = await created(m6b);
await grant(m6, 'plus');
await grant(m6b, 'plus');
const events = (kind, auto, count, from) => `INSERT INTO post_events(user_id,post_id,kind,created_at,auto) SELECT '${seeder.user.id}',(SELECT MIN(id) FROM posts WHERE title_key LIKE 'qafill${run}proxy_requestladder%'),'${kind}',${from}+value*1000,${auto}
    FROM json_each('${JSON.stringify(Array.from({ length: count }, (_, i) => i))}');`;
sql(fill('proxy_request', 'ladder', at(13, 30)) + place([p6, p6b], 'proxy_request', 'ladder', at(13)) + events('bump', 1, 2, at(13, 40)) + dueAt(m6) + dueAt(m6b));
only(m6, m6b);
await tick(at(14));
equal([autoEvents(m6).length + autoEvents(m6b).length, autoRow(m6).pause_reason, autoRow(m6b).pause_reason], [0, 'busy', 'busy'], 'A60 = 2 and O60 = 0: no bump (게시판이 붐벼 …)');
sql(events('post', 0, 9, at(13, 45)));
await tick(at(14, 10));
equal(autoEvents(m6).length + autoEvents(m6b).length, 1, 'O60 = 9: a 3rd auto bump in the hour is allowed (one per tab per tick)');
sql(dueAt(m6, at(14, 15)) + dueAt(m6b, at(14, 15)));
await tick(at(14, 20));
equal(autoEvents(m6).length + autoEvents(m6b).length, 1, 'a 4th is not');
check(JSON.parse(sql("SELECT value FROM settings WHERE key='sys:auto_count'")[0].value).delayed >= 3, 'delays are counted for the manager');

// 7. Paying members before trial members.
const paying = await register('paying');
const pp = await created(paying), tp = await created(trial2);
await grant(paying, 'plus');
sql(fill('sell', 'other', at(14, 30)) + place([pp, tp], 'sell', 'other', at(14)) + dueAt(trial2, 1) + dueAt(paying, 2) + `INSERT OR IGNORE INTO post_auto(post_id,user_id,bump) VALUES(${tp},'${trial2.user.id}',1);`);
only(paying, trial2);
await tick(at(15));
equal([autoEvents(paying).length, autoEvents(trial2).length], [1, 0], 'a trial and a paying 플러스 both due, one free slot: the paying member is bumped');

// 8. Pauses.
const a8 = await register('a8'), b1 = await register('b1'), b2 = await register('b2');
const p8 = await created(a8);
await grant(a8, 'plus');
// Away: no visit for 4 days → paused with an 알림; a request clears it.
sql(fill('buy', 'account', at(15, 30)) + place([p8], 'buy', 'account', at(15, 50)) + dueAt(a8) + `UPDATE users SET last_seen_at=${at(16) - 4 * DAY} WHERE id='${a8.user.id}';`);
only(a8);
await tick(at(16));
equal(autoRow(a8).pause_reason, 'away', 'no visit for 4 days: paused');
const alerts = (await a8('notifications')).data.alerts;
check(alerts.some(a => a.type === 'auto_paused' && a.text === '3일 동안 접속하지 않아 자동 끌올을 멈췄습니다. 접속하면 다시 시작됩니다.'), 'with one 알림');
equal(autoRow(a8).pause_reason, '', 'a visit (any request) clears the pause');
// One buyer waiting 25 hours: not paused. (The post is on page 1, so the tick has nothing to bump.)
const ask = async (buyer, text) => {
    const chat = (await buyer('chats', 'POST', { userId: a8.user.id, postId: p8 })).data.id;
    equal((await buyer(`chats/${chat}/messages`, 'POST', { body: text, postId: p8 })).status, 201, 'a buyer asks about the post');
    sql(`UPDATE messages SET created_at=${at(16, 10) - 25 * HOUR} WHERE conversation_id='${chat}'; UPDATE conversations SET updated_at=${Date.now()} WHERE id='${chat}';`);
    return chat;
};
await ask(b1, '아직 판매중인가요');
sql(dueAt(a8) + `UPDATE users SET last_seen_at=${at(16)} WHERE id='${a8.user.id}';`);
await tick(at(16, 10));
check(autoRow(a8).pause_reason !== 'reply', 'one buyer unanswered for 25 hours: not paused');
await ask(b2, '구매하고 싶습니다');
sql(dueAt(a8));
await tick(at(16, 20));
equal(autoRow(a8).pause_reason, 'reply', 'two different buyers unanswered for 25 hours: paused (reply)');
check((await a8('notifications')).data.alerts.some(a => a.type === 'auto_paused' && a.text.startsWith('답장하지 않은 채팅이 있어')), 'with its 알림');
equal((await a8('blocks', 'POST', { userId: b2.user.id, active: true })).status, 200, 'the seller blocks one of them');
sql(place([p8], 'buy', 'account', at(15)));
await tick(at(16, 30));
equal([autoRow(a8).pause_reason, autoEvents(a8).length], ['', 1], 'the next tick resumes and bumps');
// 7 days untouched: skipped; '모두 계속' resumes.
sql(`UPDATE posts SET touched_at=${Date.now() - 8 * DAY},updated_at=${Date.now() - 8 * DAY},bumped_at=${at(15)} WHERE id=${p8};` + dueAt(a8));
await tick(at(21));
equal([autoEvents(a8).length, autoRow(a8).pause_reason], [1, 'idle'], 'a post untouched for 8 days is skipped');
equal((await a8(`posts?author=${a8.user.id}&stale=1`)).data.posts.map(p => p.id), [p8], '내 글 stale=1 lists it');
equal((await a8('me/automation/continue', 'POST', {})).data.count, 1, "'모두 계속' touches it");
await tick(at(21, 10));
equal(autoEvents(a8).length, 2, 'and the next tick bumps it again');
// Monday 10:00 KST: one '자동 끌올 글 N개 확인 필요' per member with listed posts untouched for 7 days.
sql(`UPDATE posts SET touched_at=${Date.now() - 8 * DAY} WHERE id=${p8};`);
const monday = day1 + ((8 - new Date(day1 + KST).getUTCDay()) % 7) * DAY + 10 * HOUR;
await tick(monday);
const weekly = (await a8('notifications')).data.alerts.filter(a => a.type === 'auto_stale');
equal(weekly.map(a => a.text), ['자동 끌올 글 1개 확인 필요'], 'Monday 10:00: one weekly 알림 for the posts to look at');

// 9. An ended 6-month 프리미엄 and the daily cap.
const px = await register('px');
const ppx = await created(px);
await grant(px, 'premium', '6m');
sql(fill('exchange', 'account', at(16, 50)) + place([ppx], 'exchange', 'account', at(16, 40)) + dueAt(px)
    + `UPDATE user_grades SET expires_at=${Date.now() + HOUR} WHERE user_id='${px.user.id}';`);
only(px);
await tick(at(17));
equal([autoEvents(px).length, autoRow(px).bump_next_at], [0, null], 'an expired 6-month 프리미엄 is not bumped (its row is parked)');
const capm = await register('capm');
const pcap = await created(capm);
await grant(capm, 'plus');
const dayKey = new Date(at(18) - 4 * HOUR + KST).toISOString().slice(0, 10);
sql(fill('sell', 'account', at(17, 50)) + place([pcap], 'sell', 'account', at(17, 40)) + dueAt(capm)
    + `INSERT INTO settings(key,value,updated_at) VALUES('sys:auto_bump_cap','1',0),('sys:auto_count','{"day":"${dayKey}","done":1,"delayed":0}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
only(capm);
await tick(at(18));
equal([autoEvents(capm).length, autoRow(capm).pause_reason], [0, 'busy'], "sys:auto_bump_cap=1 with 1 done: none");
sql("DELETE FROM settings WHERE key='sys:auto_bump_cap'" + ';' + dueAt(capm));
await tick(at(18, 10));
equal(autoEvents(capm).length, 1, 'without the cap the member is bumped');

// 10. The '끌올 가능' 알림 (tick B, every grade).
const waiting = await created(normal);
const remind = await normal(`posts/${waiting}/auto`, 'PUT', { remind: true });
check(remind.status === 200 && remind.data.remindAt > Date.now(), 'the waiting 끌올 button sets a reminder');
await tick(at(18, 15), '5-59/10 * * * *');
const ready = (await normal('notifications')).data.alerts.find(a => a.type === 'bump_ready');
equal(ready?.text, `‘[QA] 자동 ${run} ${n}’ 글 끌올 가능`, "tick B sends '‘제목’ 글 끌올 가능'");
equal(sql(`SELECT bump_remind FROM post_auto WHERE post_id=${waiting}`)[0].bump_remind, 0, 'once');

// 11. The budget: 30 due members, one tick A ≤ 8 D1 calls and ≤ 45 statements.
const bulk = Array.from({ length: 30 }, (_, i) => i);
sql(`INSERT INTO users(id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at,last_seen_at)
        SELECT 'au-${run}-'||value,'ab_${run}_'||value,'ab${run}b'||value,'ab${run}b'||value,'','','member','',${Date.now()},${at(19)} FROM json_each('${JSON.stringify(bulk)}');
    INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) SELECT 'au-${run}-'||value,'plus',1,NULL,'manager',${Date.now()},'manager' FROM json_each('${JSON.stringify(bulk)}');
    INSERT INTO automation(user_id,bump_on,bump_next_at,updated_at) SELECT 'au-${run}-'||value,1,1,0 FROM json_each('${JSON.stringify(bulk)}');
    INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,created_at,updated_at,touched_at,bumped_at,title_key)
        SELECT 'au-${run}-'||value,CASE value%3 WHEN 0 THEN 'sell' WHEN 1 THEN 'buy' ELSE 'exchange' END,'[QA] bulk ${run} '||value,'bulk',10000,'open','account','fixed',${Date.now() - DAY},${Date.now()},${Date.now()},${at(17)},'qabulk${run}'||value FROM json_each('${JSON.stringify(bulk)}');
    INSERT INTO post_auto(post_id,user_id,bump) SELECT id,author_id,1 FROM posts WHERE title_key LIKE 'qabulk${run}%';` + fill('sell', 'account', at(18, 30)) + fill('buy', 'account', at(18, 30)));
sql(`UPDATE automation SET bump_on=CASE WHEN user_id LIKE 'au-${run}-%' THEN 1 ELSE 0 END WHERE bump_on=1 OR user_id LIKE 'au-${run}-%'`);
const meter = await tick(at(19));
console.log('  tick A meter', JSON.stringify(meter));
check(meter.d1Calls <= 8, `30 due members: ${meter.d1Calls} D1 calls (≤ 8)`);
check(meter.d1Statements <= 45, `${meter.d1Statements} statements (≤ 45)`);
const bulkDone = sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id LIKE 'au-${run}-%' AND auto=1`)[0].n;
check(bulkDone >= 1 && bulkDone <= 3, `one tick bumps at most one post per tab (${bulkDone})`);
const meterB = await tick(at(19, 5), '5-59/10 * * * *');
check(meterB.d1Calls <= 8 && meterB.d1Statements <= 45, `tick B stays in the budget too (${meterB.d1Calls} calls, ${meterB.d1Statements} statements)`);

// The daily cron copies yesterday's window counts for the manager and resets auto_today.
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:auto_count','{"day":"${new Date(Date.now() - 4 * HOUR + KST).toISOString().slice(0, 10)}","done":46,"delayed":120}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const daily = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('17 18 * * *')}`, () => ({ signal: AbortSignal.timeout(60000) }));
await daily.arrayBuffer();
equal((await manager('manage')).data.usage.autoYesterday, { done: 46, delayed: 120 }, "the manager's 사용량 reads '자동 끌올 어제 46번 · 지연 120번'");
equal(autoRow(plus).auto_today, 0, 'the daily cron resets auto_today');

// Leave nothing ahead of now for the suites that follow, and switch every test row off.
sql(`UPDATE posts SET bumped_at=MIN(created_at,${Date.now()}) WHERE bumped_at>${Date.now() + 2 * HOUR};
    DELETE FROM post_events WHERE created_at>${Date.now() + 2 * HOUR};
    UPDATE users SET bump_at=${Date.now()} WHERE bump_at>${Date.now() + 2 * HOUR};
    UPDATE automation SET bump_on=0 WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'au_${run}_%') OR user_id LIKE 'au-${run}-%';
    DELETE FROM posts WHERE title_key LIKE 'qafill${run}%' OR title_key LIKE 'qabulk${run}%' OR title_key LIKE 'qae2${run}%';
    DELETE FROM settings WHERE key IN ('sys:auto_count','sys:auto_bump_cap')`);
console.log(`\n${checks} auto checks passed`);
