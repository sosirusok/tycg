import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 자동 가격 내리기 (WP56) on the strict 8791 server (no assets, --test-scheduled, TEST_HOOKS=on, READ_BUDGET=on).
// It runs right after verify-auto (its own file so each suite stays inside its time limit): the refusals,
// the drops with their struck price history, 찜 가격 내림 and the end at the 최저가, the 현젯 stop, the hold on
// a buyer chat message or a 제시 (every grade) and on an accepted 제시 until 수락 취소, the bump only with
// 3 끌올 in the wallet, 프리미엄's 12-hour 5% steps, 엘리트's 판매 글 전체 and 최저가 미만 제시 자동 거절, the
// away pause, 완료 and the per-run budget. Ticks take the test event's scheduledTime (?time=) as now, at
// 20:00 KST on days after tomorrow; every 자동 끌올 row is switched off before each tick, so only the
// drops (and their bumps) move posts.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, KST = 9 * HOUR;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

function sql(command) {
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
    return async (path, method = 'GET', data) => {
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
}

let regs = 0;
async function register(name) {
    const c = client(`10.56.${Math.floor(regs / 200)}.${1 + (regs++ % 200)}`);
    const r = await c('auth/register', 'POST', { username: `ad_${run}_${name}`.slice(0, 24), password, nickname: `내림${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// Every 자동 끌올 row off (only the drops move posts) and this run's members seen at the tick's time (the
// ticks run days ahead, past the 3-day away pause), then `setup`, then tick A at `at`; returns the run's meter.
async function tick(at, setup = '') {
    sql(`UPDATE automation SET bump_on=0 WHERE bump_on=1; UPDATE users SET last_seen_at=${at} WHERE username LIKE 'ad\\_${run}\\_%' ESCAPE '\\';` + setup);
    const r = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/10 * * * *')}&time=${at}`, () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    assert.equal(r.status, 200, `tick at ${new Date(at).toISOString()} answered ${r.status}`);
    const meter = JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || '{}');
    if (process.env.DROP_METER) console.log('  meter', JSON.stringify(meter));
    return meter;
}

// 20:00 KST, `d` days after tomorrow (tomorrow's hours belong to verify-auto).
const day1 = Date.now() - ((Date.now() + KST) % DAY) + DAY;
const eight = (d, m = 0) => day1 + (d + 1) * DAY + 20 * HOUR + m * MIN;
// The first 20:00 KST at or after t (12-hour period: 08:00 or 20:00).
const slot = (t, h = 24) => { const s = h === 12 ? 12 * HOUR : DAY, off = 11 * HOUR % s; return Math.ceil((t - off) / s) * s + off; };

sql(`DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'post:%' OR key LIKE 'offer:%'; UPDATE post_auto SET drop_on=0 WHERE drop_on=1;
    DELETE FROM post_events WHERE created_at>${Date.now() + 2 * HOUR}; UPDATE posts SET bumped_at=MIN(created_at,${Date.now()}) WHERE bumped_at>${Date.now() + 2 * HOUR};`);

const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade) => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan: 'permanent' })).status, 201, `manager grants ${grade}`);

let n = 0;
async function created(c, extra = {}) {
    const r = await c('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 내림 ${run} ${++n}`, body: '가격 내리기 검증', price: 300000, tags: [], images: [], details: {}, ...extra });
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
const drop = (c, id, on, floor) => c(`posts/${id}/auto`, 'PUT', { drop: on ? { on, floor } : { on } });
const row = id => sql(`SELECT p.price,p.bumped_at,pa.drop_on,pa.drop_next_at,pa.drop_count,pa.drop_floor,(SELECT json_group_array(price) FROM (SELECT price FROM post_price_history WHERE post_id=p.id ORDER BY id)) AS history
    FROM posts p LEFT JOIN post_auto pa ON pa.post_id=p.id WHERE p.id=${id}`).map(r => ({ ...r, history: JSON.parse(r.history) }))[0];
const due = id => `UPDATE post_auto SET drop_next_at=1 WHERE post_id=${id};`;
const alertsOf = async (c, type) => (await c('notifications')).data.alerts.filter(a => a.type === type);

// 1. Refusals.
const normal = await register('normal');
const normalPost = await created(normal);
refused(await drop(normal, normalPost, true, 280000), 403, '가격 내리기는 플러스부터 가능합니다.', '일반 cannot switch it on');
const plus = await register('plus'), buyer = await register('buyer');
const p1 = await created(plus), p2 = await created(plus), offerOnly = await created(plus, { price: null });
await grant(plus, 'plus');
refused(await plus('me/automation', 'PUT', { dropEveryH: 12 }), 400, '내림 주기를 확인해 주세요.', '플러스 cannot pick 12시간');
refused(await plus('me/automation', 'PUT', { dropPct: 5 }), 400, '내림 폭을 확인해 주세요.', '플러스 cannot pick 5%');
refused(await drop(plus, offerOnly, true, 100000), 400, '즉거가가 있는 판매 글만 가격 내리기를 할 수 있습니다.', 'a 가격 제시 post is refused');
refused(await drop(plus, p1, true, 300000), 400, '최저가는 즉거가보다 낮게 입력해 주세요.', 'floor ≥ 즉거가 is refused');
refused(await drop(plus, p1, true, 500), 400, '최저가는 즉거가보다 낮게 입력해 주세요.', 'floor under 1,000원 is refused');
const before = Date.now();
const on = await drop(plus, p1, true, 280000);
equal([on.status, on.data.drop.on, on.data.drop.floor, on.data.drop.nextPrice], [200, true, 280000, 290000], 'plus switches it on: 최저가 28만원, next 29만원');
check(on.data.drop.nextAt >= slot(before + DAY) && on.data.drop.nextAt <= slot(Date.now() + DAY) && (on.data.drop.nextAt + KST) % DAY === 20 * HOUR, `the first drop is the next 20:00 KST a day later (${new Date(on.data.drop.nextAt).toISOString()})`);
refused(await drop(plus, p2, true, 250000), 409, '가격 내리기는 글 1개까지입니다.', 'a 2nd 플러스 post is refused');
const detail = (await plus('posts/' + p1)).data.post.auto.drop;
equal([detail.on, detail.nextPrice], [true, 290000], 'GET posts/:id gives the owner the status');
const autoTab = (await plus('me/automation')).data;
equal([autoTab.drop.slots, autoTab.drop.everyH, autoTab.drop.everyOptions, autoTab.drop.on, autoTab.drop.canPct], [1, 24, [24], 1, false], 'GET me/automation: 1 post, a day');
equal(autoTab.posts.find(p => p.id === offerOnly).drop, null, 'a 가격 제시 post has no 가격 내리기 row');
equal(autoTab.posts.find(p => p.id === p2).drop.floor, 240000, 'the 최저가 is prefilled with 80% rounded down to 만원');
equal((await buyer(`posts/${p1}/favorite`, 'POST', { active: true })).status, 200, 'the buyer saves the post');

// 2. A drop with 2 끌올 in the wallet: the price drops, no bump. Then with 5: bumped, 4 left.
const bumped0 = row(p1).bumped_at;
await tick(eight(0), due(p1) + `UPDATE users SET bump_tokens=2,bump_at=${eight(0)} WHERE id='${plus.user.id}';`);
let r1 = row(p1);
equal([r1.price, r1.history, r1.drop_count, r1.bumped_at], [290000, [300000], 1, bumped0], 'a drop with 2 끌올: 30만원 → 29만원, struck 30만원, not bumped');
equal(r1.drop_next_at, eight(1), 'the next drop is one period later');
const fav = await alertsOf(buyer, 'fav_price');
equal(fav.map(a => a.text), [`가격 내림 · [QA] 내림 ${run} 2 29만원`], 'the member who saved it gets 가격 내림');
await tick(eight(1), due(p1) + `UPDATE users SET bump_tokens=5,bump_at=${eight(1)} WHERE id='${plus.user.id}';`);
r1 = row(p1);
const wallet = sql(`SELECT bump_tokens FROM users WHERE id='${plus.user.id}'`)[0].bump_tokens;
const events = sql(`SELECT post_id,auto FROM post_events WHERE post_id=${p1} AND kind='bump' AND created_at=${eight(1)}`);
equal([r1.price, r1.history, r1.bumped_at, wallet, events], [280000, [300000, 290000], eight(1), 4, [{ post_id: p1, auto: 1 }]], 'a drop with 5 끌올: 28만원, bumped, 4 left, an auto=1 event');
const counted = JSON.parse(sql("SELECT value FROM settings WHERE key='sys:auto_count'")[0]?.value || '{}');
check(counted.day === new Date(eight(1) - 4 * HOUR + KST).toISOString().slice(0, 10) && counted.done >= 1, `the drop's bump counts in the day's 자동 끌올 counter (${JSON.stringify(counted)})`);
check(sql(`SELECT auto_today FROM automation WHERE user_id='${plus.user.id}'`)[0]?.auto_today >= 1, "and in the member's auto_today (the fair-share order)");
await tick(eight(2), due(p1));
r1 = row(p1);
equal([r1.price, r1.drop_on], [280000, 0], 'at the 최저가 the next tick ends it');
equal((await alertsOf(plus, 'drop_done')).map(a => a.text), [`‘[QA] 내림 ${run} 2’ 글이 최저가에 닿아 가격 내리기를 마쳤습니다.`], "with 'drop_done'");

// 3. A 현젯 at or above the next price stops it.
equal((await plus(`posts/${p2}/price`, 'PATCH', { price: 290000, currentOffer: 285000 })).status, 200, '즉거가 29만원, 현젯 28만 5천원');
equal((await drop(plus, p2, true, 250000)).status, 200, 'the freed slot takes another post');
await tick(eight(3), due(p2));
const r2 = row(p2);
equal([r2.price, r2.drop_on], [290000, 0], '현젯 285,000 with the next price 280,000: unchanged and off');
equal((await alertsOf(plus, 'drop_stopped')).map(a => a.text), [`‘[QA] 내림 ${run} 3’ 글 현젯이 다음 가격 이상이라 가격 내리기를 멈췄습니다.`], "with 'drop_stopped'");

// 4. Hold (every grade): a buyer's chat message since the last drop → no drop, one period later.
const p3 = await created(plus);
equal((await drop(plus, p3, true, 250000)).status, 200, 'a new setup');
sql(`UPDATE post_auto SET drop_checked_at=${Date.now() - MIN} WHERE post_id=${p3};`);
const chat = (await buyer('chats', 'POST', { userId: plus.user.id, postId: p3 })).data.id;
equal((await buyer(`chats/${chat}/messages`, 'POST', { body: '아직 판매중인가요', postId: p3 })).status, 201, 'a buyer asks about it');
await tick(eight(4), due(p3));
let r3 = row(p3);
equal([r3.price, r3.drop_next_at, r3.drop_count], [300000, eight(5), 0], 'a buyer chat message since the last drop: unchanged, drop_next_at moves one period');
await tick(eight(5), due(p3));
equal(row(p3).price, 290000, 'with nothing new the next tick drops');
// The away pause: no visit for 4 days → not dropped.
await tick(eight(6), due(p3) + `UPDATE users SET last_seen_at=${eight(6) - 4 * DAY} WHERE id='${plus.user.id}';`);
r3 = row(p3);
equal([r3.price, r3.drop_on], [290000, 1], 'last visit 4 days ago: not dropped (still on)');
// 완료 ends it.
equal((await plus(`posts/${p3}/status`, 'PATCH', { status: 'closed' })).status, 200, 'the post is completed');
equal(row(p3).drop_on, 0, '완료 ends the setup');

// 4b. The hold follows the post the chat is about now: a buyer who asked about q1 and has since moved on to
// q2 in the same chat (one chat per pair) does not hold q1's drop.
const plus2 = await register('plus2');
const q1 = await created(plus2), q2 = await created(plus2);
await grant(plus2, 'plus');
equal((await drop(plus2, q1, true, 250000)).status, 200, 'a setup on q1');
const pairChat = (await buyer('chats', 'POST', { userId: plus2.user.id, postId: q1 })).data.id;
equal((await buyer(`chats/${pairChat}/messages`, 'POST', { body: '아직 판매중인가요', postId: q1 })).status, 201, 'the buyer asks about q1');
sql(`UPDATE post_auto SET drop_checked_at=${Date.now()} WHERE post_id=${q1};`);
equal((await buyer(`chats/${pairChat}/messages`, 'POST', { body: '이 글도 판매중인가요', postId: q2 })).status, 201, 'later, in the same chat, about q2');
await tick(eight(5, 10), due(q1));
equal(row(q1).price, 290000, 'a message about q2 does not hold q1: dropped');

// 5. 프리미엄: 12시간 and 5%.
const premium = await register('premium');
const pp = await created(premium);
await grant(premium, 'premium');
equal((await premium('me/automation', 'PUT', { dropEveryH: 12, dropPct: 5 })).data.drop.pct, 5, '프리미엄 picks 12시간 and 5%');
const ppOn = await drop(premium, pp, true, 200000);
equal(ppOn.data.drop.nextPrice, 285000, 'the next price is 5% lower');
check((ppOn.data.drop.nextAt + KST) % (12 * HOUR) === 8 * HOUR, 'the first drop is at 08:00 or 20:00 KST');
await tick(eight(7), due(pp));
equal([row(pp).price, row(pp).drop_next_at], [285000, eight(7) + 12 * HOUR], '30만원 → 28만 5천원, the next one 12 hours later');

// 6. Accepted 제시 and offers (엘리트, also the decline switch).
const elite = await register('elite'), b2 = await register('b2'), b3 = await register('b3');
const ep = await created(elite, { accepts_offers: true });
await grant(elite, 'elite');
equal((await drop(elite, ep, true, 280000)).status, 200, 'an 엘리트 setup on a post that takes 제시');
const offer = await buyer('offers', 'POST', { postId: ep, amount: 290000 });
equal(offer.status, 201, 'a 제시 of 29만원');
await tick(eight(8), due(ep));
equal([row(ep).price, row(ep).drop_next_at], [300000, eight(9)], 'a 제시 since the last look: held one period');
equal((await elite(`offers/${offer.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'the seller accepts it');
await tick(eight(9), due(ep));
equal(row(ep).price, 300000, 'an accepted 제시: held');
equal((await elite(`offers/${offer.data.id}`, 'PATCH', { action: 'released' })).status, 200, '수락 취소');
await tick(eight(10), due(ep));
equal(row(ep).price, 290000, 'after 수락 취소 the next tick drops');
refused(await plus('me/automation', 'PUT', { declineOn: true }), 403, '최저가 미만 제시 자동 거절은 엘리트부터 가능합니다.', '플러스 has no auto decline');
equal((await elite('me/automation', 'PUT', { declineOn: true })).data.drop.declineOn, true, '엘리트 turns 최저가 미만 제시 자동 거절 on');
const low = await b2('offers', 'POST', { postId: ep, amount: 250000 });
equal([low.status, low.data.declined], [201, true], 'a 제시 under the 최저가 is answered as declined');
equal(sql(`SELECT status FROM offers WHERE id='${low.data.id}'`)[0].status, 'declined', "it is stored as 'declined'");
const lines = sql(`SELECT body FROM messages WHERE conversation_id='${low.data.chatId}' AND type='system'`).map(m => m.body);
equal(lines, ['제시 자동 거절 · 25만원'], "the chat has '제시 자동 거절 · 25만원' for both sides");
equal((await elite('me/automation', 'PUT', { declineOn: false })).data.drop.declineOn, false, 'switched off');
const kept = await b3('offers', 'POST', { postId: ep, amount: 250000 });
equal([kept.status, sql(`SELECT status FROM offers WHERE id='${kept.data.id}'`)[0].status], [201, 'pending'], 'with the switch off the same 제시 stays pending');

// 7. 판매 글 전체 (엘리트): every priced 판매 post, 최저가 80% rounded down to 만원.
const elite2 = await register('elite2');
const prices = [300000, 155000, 99000, 1000000], all = [];
for (const price of prices) all.push(await created(elite2, { price }));
await grant(elite2, 'elite');
refused(await premium('me/automation/drop-all', 'POST', {}), 403, '판매 글 전체는 엘리트부터 가능합니다.', '프리미엄 has no 판매 글 전체');
const allOn = await elite2('me/automation/drop-all', 'POST', {});
equal([allOn.status, allOn.data.count], [200, 4], '판매 글 전체 switches 4 posts on');
equal(all.map(id => [row(id).drop_on, row(id).drop_floor]), [[1, 240000], [1, 120000], [1, 70000], [1, 800000]], 'floors at 80% rounded down to 만원');

// 8. The budget: 30 due setups → one tick A ≤ 8 D1 calls, ≤ 45 statements and no scan of the posts table.
const bulk = Array.from({ length: 30 }, (_, i) => i);
sql(`INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,created_at,updated_at,touched_at,bumped_at,title_key)
        SELECT '${elite2.user.id}','sell','[QA] dbulk ${run} '||value,'bulk',500000,'open','other','fixed',${Date.now()},${Date.now()},${Date.now()},${Date.now()},'qadbulk${run}'||value FROM json_each('${JSON.stringify(bulk)}');
    INSERT INTO post_auto(post_id,user_id,drop_on,drop_floor,drop_next_at,drop_count,drop_set_at,drop_checked_at) SELECT id,author_id,1,100000,1,0,${Date.now()},${Date.now()} FROM posts WHERE title_key LIKE 'qadbulk${run}%';`);
const meter = await tick(eight(11));
console.log('  tick A meter', JSON.stringify(meter));
check(meter.d1Calls <= 8, `30 due setups: ${meter.d1Calls} D1 calls (≤ 8)`);
check(meter.d1Statements <= 45, `${meter.d1Statements} statements (≤ 45)`);
check(meter.rowsRead < 5000, `${meter.rowsRead} rows read (the writes look posts up by id, < 5,000)`);
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE title_key LIKE 'qadbulk${run}%' AND price=490000`)[0].n, 30, 'all 30 dropped in one run');

// Nothing ahead of now stays for the suites that follow.
sql(`UPDATE post_auto SET drop_on=0 WHERE drop_on=1;
    UPDATE posts SET bumped_at=MIN(created_at,${Date.now()}) WHERE bumped_at>${Date.now() + 2 * HOUR};
    DELETE FROM post_events WHERE created_at>${Date.now() + 2 * HOUR};
    UPDATE users SET bump_at=${Date.now()} WHERE bump_at>${Date.now() + 2 * HOUR};
    DELETE FROM posts WHERE title_key LIKE 'qadbulk${run}%'`);
console.log(`\n${checks} price drop checks passed`);
