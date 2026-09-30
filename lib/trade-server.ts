import { db, bucket, fail, currentUser, requireUser, json, body, limit, textField, initManager } from './server';
import { CATEGORIES, TRADE_KINDS, DETAIL_FIELDS, BUYER_DETAIL_FIELDS, ACCOUNT_CHOICES, RECORD_PREFERENCES, NICK_RANKS, SKIN_TAGS, FULL_SET, LEGACY_SKELETON, categoriesForKind, normalizeTrade, validTags, type DetailField, type SeasonTag, type User } from './market';
const select = 'SELECT p.*,u.nickname,u.role FROM posts p JOIN users u ON u.id=p.author_id';
const parse = (s: string, f: any) => { try {
    return JSON.parse(s);
}
catch {
    return f;
} };
async function rawPost(id: string | number) { return db().prepare(select + ' WHERE p.id=?').bind(id).first<any>(); }
async function visiblePost(id: string | number, u: User | null) { const p = await rawPost(id); if (!p || p.hidden && p.author_id !== u?.id && u?.role !== 'manager')
    fail(404, '게시글을 찾을 수 없습니다.'); return p; }
async function decorate(rows: any[], uid?: string) {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map(p => p.id));
    const [tags, favs, histories] = await db().batch([
        db().prepare('SELECT post_id,tier,season FROM post_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id FROM favorites WHERE user_id=? AND post_id IN (SELECT value FROM json_each(?))').bind(uid || '', ids),
        db().prepare('SELECT post_id,price,changed_at FROM post_price_history WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(ids),
    ]);
    return rows.map(p => ({
        ...p, ...normalizeTrade(p.kind, p.category),
        price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
        details: parse(p.details, {}), images: parse(p.images, []),
        tags: tags.results.filter((t: any) => t.post_id === p.id).map((t: any) => ({ tier: t.tier, season: t.season })),
        favorite: favs.results.some((f: any) => f.post_id === p.id),
        price_history: p.kind === 'sell' ? histories.results.filter((h: any) => h.post_id === p.id).map((h: any) => ({ price: h.price, changed_at: h.changed_at })) : [],
    }));
}
async function blocked(a: string, b: string) { return !!await db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').bind(a, b, b, a).first(); }
async function chatMember(id: string, uid: string) { const c = await db().prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').bind(id, uid, uid).first<any>(); if (!c)
    fail(404, '대화를 찾을 수 없습니다.'); return c; }
async function ensureChat(a: string, b: string) { if (a === b)
    fail(400, '다른 회원과 대화할 수 있습니다.'); if (!await db().prepare('SELECT id FROM users WHERE id=?').bind(b).first())
    fail(404, '회원을 찾을 수 없습니다.'); if (await blocked(a, b))
    fail(403, '차단된 회원과는 대화하거나 제안할 수 없습니다.'); const pair = [a, b].sort(), now = Date.now(); await db().prepare('INSERT OR IGNORE INTO conversations(id,user_a,user_b,created_at,updated_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), ...pair, now, now).run(); return (await db().prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first<any>()).id as string; }
function amount(v: any, optional = true) { if (v === null || v === '' || v === undefined) {
    if (optional)
        return null;
    fail(400, '가격을 입력해 주세요.');
} if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !/^\d+$/.test(v.trim()))) fail(400, '가격은 숫자로 입력해 주세요.'); const n = Number(v); if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000)
    fail(400, '가격은 0~10억 원의 정수로 입력해 주세요.'); return n; }
function numericDetail(details: Record<string, string>, key: string, label: string, min: number, max: number) {
    if (!details[key]) return;
    if (!/^\d+$/.test(details[key]) || Number(details[key]) < min || Number(details[key]) > max)
        fail(400, `${label}은 ${min}~${max} 사이의 정수로 입력해 주세요.`);
    details[key] = String(Number(details[key]));
}
function selectedDetails(details: Record<string, string>, key: string, allowed: readonly string[], label: string, includeLegacySet = false) {
    if (!details[key]) return;
    const chosen = parse(details[key], null);
    if (!Array.isArray(chosen) || chosen.length > allowed.length || chosen.some(v => typeof v !== 'string' || !allowed.includes(v)))
        fail(400, `${label}을 확인해 주세요.`);
    if (includeLegacySet && chosen.includes(FULL_SET) && !chosen.includes(LEGACY_SKELETON)) chosen.push(LEGACY_SKELETON);
    details[key] = JSON.stringify([...new Set(chosen)]);
}
function validateBuyerDetails(details: Record<string, string>, prefix = '') {
    const key = (name: string) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
    numericDetail(details, key('maxOwners'), '허용 대주 수', 1, 9999);
    numericDetail(details, key('nicknameCharsMin'), '닉네임 최소 글자 수', 1, 20);
    numericDetail(details, key('nicknameCharsMax'), '닉네임 최대 글자 수', 1, 20);
    if (details[key('nicknameCharsMin')] && details[key('nicknameCharsMax')] && Number(details[key('nicknameCharsMin')]) > Number(details[key('nicknameCharsMax')]))
        fail(400, '닉네임 최소 글자 수가 최대 글자 수보다 클 수 없습니다.');
    if (details[key('recordPreference')] && !RECORD_PREFERENCES.includes(details[key('recordPreference')] as typeof RECORD_PREFERENCES[number]))
        fail(400, '전적 조건을 확인해 주세요.');
    selectedDetails(details, key('nicknameRanks'), NICK_RANKS, '닉 등급 선택');
    selectedDetails(details, key('skinTags'), SKIN_TAGS, '스킨 선택', true);
}
async function validatePost(b: any, u: User, existing?: any) {
    const title = textField(b.title, 2, 100, '제목'), content = textField(b.body, 1, 10000, '설명');
    if (!TRADE_KINDS.includes(b.kind)) fail(400, '거래 구분을 선택해 주세요.');
    const category = b.category || categoriesForKind(b.kind)[0].id;
    if (!categoriesForKind(b.kind).some(c => c.id === category)) fail(400, '거래 구분에 맞는 종류를 선택해 주세요.');
    if (!validTags(b.tags)) fail(400, '티어와 시즌을 확인해 주세요.');
    const tags = category === 'account' || category === 'ladder' ? [...new Map((b.tags as SeasonTag[]).map(t => [t.tier + ':' + t.season, t])).values()] : [];
    // Price meaning is determined by the trade kind, never by a stale form's mode.
    const price = b.kind === 'exchange' ? null : amount(b.price);
    const mode = price !== null ? 'fixed' : b.kind === 'sell' ? 'offer' : 'negotiate';
    const details: Record<string, string> = {};
    let fields: DetailField[] = category === 'account' && b.kind === 'buy' ? BUYER_DETAIL_FIELDS : DETAIL_FIELDS[category];
    if (b.kind === 'exchange') {
        if (!['account', 'clan'].includes(b.details?.wantedCategory)) fail(400, '구하는 교환 대상을 선택해 주세요.');
        fields = [...fields, { id: 'wantedCategory', label: '구하는 대상' }];
        if (b.details.wantedCategory === 'account') fields = [...fields, ...BUYER_DETAIL_FIELDS.map(f => ({ ...f, id: 'wanted' + f.id[0].toUpperCase() + f.id.slice(1) }))];
    }
    if (b.kind === 'sell') fields = [...fields, { id: 'currentOffer', label: '현젯', type: 'number' }];
    for (const f of fields) {
        const raw = b.details?.[f.id];
        if (raw === undefined || raw === '') continue;
        if (typeof raw !== 'string' || raw.length > 500) fail(400, `${f.label}은 500자 이내로 입력해 주세요.`);
        const v = raw.trim();
        if (!v) continue;
        if (f.type === 'number' && (!/^\d+$/.test(v) || Number(v) > 1000000000)) fail(400, `${f.label}에 올바른 숫자를 입력해 주세요.`);
        details[f.id] = v;
    }
    if (category === 'account' && b.kind !== 'buy') {
        for (const [key, f] of Object.entries(ACCOUNT_CHOICES)) {
            if (details[key] && !f.options.includes(details[key])) fail(400, `${f.label}을 확인해 주세요.`);
        }
        numericDetail(details, 'ownerCount', '대주 수', 1, 9999);
        numericDetail(details, 'nicknameChars', '닉 글자 수', 1, 20);
        selectedDetails(details, 'skinTags', SKIN_TAGS, '스킨 선택', true);
    }
    if (category === 'account' && b.kind === 'buy') validateBuyerDetails(details);
    if (b.kind === 'exchange' && details.wantedCategory === 'account') validateBuyerDetails(details, 'wanted');
    if (details.currentOffer) details.currentOffer = String(amount(details.currentOffer, false));
    // This retired free-text field has no new input. Preserve original seller data on edits.
    if (category === 'account' && b.kind !== 'buy' && existing?.category === 'account') {
        const legacySkins = parse(existing.details, {}).rareSkins;
        if (typeof legacySkins === 'string' && legacySkins) details.rareSkins = legacySkins;
    }
    const images = b.images || [];
    if (!Array.isArray(images) || images.length > 6 || images.some(x => typeof x !== 'string') || new Set(images).size !== images.length)
        fail(400, '사진은 최대 6장까지 첨부할 수 있습니다.');
    if (images.length) {
        const r = await db().prepare('SELECT id FROM uploads WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(images)).all();
        if (r.results.length !== images.length) fail(403, '본인이 업로드한 사진만 사용할 수 있습니다.');
    }
    const status = b.status || 'open';
    if (!['open', 'reserved', 'closed'].includes(status)) fail(400, '거래 상태를 확인해 주세요.');
    return { kind: b.kind, title, content, category, tags, price, mode, details: JSON.stringify(details), images: JSON.stringify(images), status, accepts: b.kind === 'exchange' ? 0 : b.accepts_offers || mode === 'offer' ? 1 : 0 };
}
export async function tradeHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'stats' && method === 'GET') {
        await initManager();
        const r = await db().batch([db().prepare('SELECT COUNT(*) AS count FROM users'), db().prepare('SELECT COUNT(*) AS count FROM posts WHERE hidden=0'), db().prepare('SELECT category,COUNT(*) AS count FROM posts WHERE hidden=0 AND status!=? GROUP BY category').bind('closed')]);
        return json({ members: (r[0].results[0] as any).count, posts: (r[1].results[0] as any).count, categories: r[2].results });
    }
    if (p[0] === 'posts') {
        if (method === 'GET' && !p[1]) {
            const u = await currentUser(req), s = url.searchParams, where = ['p.hidden=0'], values: any[] = [];
            for (const [param, col, allowed] of [['kind', 'kind', TRADE_KINDS], ['category', 'category', CATEGORIES.map(c => c.id)], ['status', 'status', ['open', 'reserved', 'closed']]] as [
                string,
                string,
                string[]
            ][]) {
                const v = s.get(param);
                if (v && allowed.includes(v)) {
                    where.push('p.' + col + '=?');
                    values.push(v);
                }
            }
            if (s.get('author')) {
                where.push('p.author_id=?');
                values.push(s.get('author'));
            }
            if (s.get('active') === '1')
                where.push("p.status!='closed'");
            if (s.get('mode') && ['fixed', 'offer', 'negotiate'].includes(s.get('mode')!)) {
                where.push("(CASE WHEN p.price_mode='legacy' THEN CASE WHEN p.price IS NULL THEN 'negotiate' ELSE 'fixed' END ELSE p.price_mode END)=?");
                values.push(s.get('mode'));
            }
            const q = s.get('q')?.trim().slice(0, 100);
            if (q) {
                where.push("(instr(lower(p.title),lower(?))>0 OR instr(lower(p.body),lower(?))>0 OR instr(lower(replace(p.details,' ','')),lower(replace(?,' ','')))>0)");
                values.push(q, q, q);
            }
            for (const [key, op] of [['min', '>='], ['max', '<=']]) {
                const n = s.get(key);
                if (n !== null && n !== '') {
                    where.push('p.price' + op + '?');
                    values.push(amount(n, false));
                }
            }
            for (const [key, path] of [['level', 'level'], ['skins', 'humanSkins'], ['gas', 'gas'], ['minerals', 'minerals']]) {
                const v = s.get(key);
                if (v) {
                    where.push(`CAST(json_extract(p.details,'$.${path}') AS INTEGER)>=?`);
                    values.push(amount(v, false));
                }
            }
            const buying = s.get('kind') === 'buy';
            const queryInteger = (key: string, min: number, max: number) => {
                const value = s.get(key);
                if (value === null || value === '') return null;
                if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) fail(400, '숫자 검색 조건을 확인해 주세요.');
                return Number(value);
            };
            const nicknameChars = queryInteger('nicknameChars', 1, 20);
            if (nicknameChars !== null) {
                if (buying) {
                    where.push("(json_extract(p.details,'$.nicknameCharsMin') IS NULL OR CAST(json_extract(p.details,'$.nicknameCharsMin') AS INTEGER)<=?) AND (json_extract(p.details,'$.nicknameCharsMax') IS NULL OR CAST(json_extract(p.details,'$.nicknameCharsMax') AS INTEGER)>=?)");
                    values.push(nicknameChars, nicknameChars);
                } else {
                    where.push("CAST(json_extract(p.details,'$.nicknameChars') AS INTEGER)=?");
                    values.push(nicknameChars);
                }
            }
            const maxOwners = queryInteger('maxOwners', 1, 9999);
            if (maxOwners !== null) {
                where.push("CAST(json_extract(p.details,'$.ownerCount') AS INTEGER)<=?");
                values.push(maxOwners);
            }
            const ownerCountOfMine = queryInteger('ownerCountOfMine', 1, 9999);
            if (ownerCountOfMine !== null) {
                where.push("(json_extract(p.details,'$.maxOwners') IS NULL OR CAST(json_extract(p.details,'$.maxOwners') AS INTEGER)>=?)");
                values.push(ownerCountOfMine);
            }
            for (const [key, f] of Object.entries(ACCOUNT_CHOICES)) {
                const v = s.get(key);
                if (!v) continue;
                if (!f.options.includes(v)) fail(400, `${f.label} 검색 조건을 확인해 주세요.`);
                if (buying && key === 'nicknameRank') {
                    where.push("(json_array_length(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]'))=0 OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]')) WHERE value=?))");
                } else {
                    where.push(`json_extract(p.details,'$.${key}')=?`);
                }
                values.push(v);
            }
            for (const key of ['recordPreference', 'wantedRecordPreference']) {
                const v = s.get(key);
                if (!v) continue;
                if (!RECORD_PREFERENCES.includes(v as typeof RECORD_PREFERENCES[number])) fail(400, '전적 검색 조건을 확인해 주세요.');
                where.push(`json_extract(p.details,'$.${key}')=?`);
                values.push(v);
            }
            const wantedCategory = s.get('wantedCategory');
            if (wantedCategory) {
                if (!['account', 'clan'].includes(wantedCategory)) fail(400, '구하는 교환 대상을 확인해 주세요.');
                where.push("json_extract(p.details,'$.wantedCategory')=?");
                values.push(wantedCategory);
            }
            for (const key of ['nicknameCharsMin', 'nicknameCharsMax', 'wantedNicknameCharsMin', 'wantedNicknameCharsMax', 'wantedMaxOwners']) {
                const n = queryInteger(key, 1, key === 'wantedMaxOwners' ? 9999 : 20);
                if (n === null) continue;
                where.push(`CAST(json_extract(p.details,'$.${key}') AS INTEGER)=?`);
                values.push(n);
            }
            for (const key of ['skinTags', 'wantedSkinTags', 'nicknameRanks', 'wantedNicknameRanks']) {
                if (!s.get(key)) continue;
                const chosen = parse(s.get(key)!, null), allowed: readonly string[] = key.endsWith('SkinTags') || key === 'skinTags' ? SKIN_TAGS : NICK_RANKS;
                if (!Array.isArray(chosen) || chosen.length > allowed.length || chosen.some(v => typeof v !== 'string' || !allowed.includes(v))) fail(400, '선택한 검색 조건을 확인해 주세요.');
                if (chosen.length) {
                    where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.${key}'),'[]')) selected JOIN json_each(?) wanted ON selected.value=wanted.value)`);
                    values.push(JSON.stringify(chosen));
                }
            }
            const raw = s.get('tags');
            if (raw) {
                const tags = parse(raw, null);
                if (!validTags(tags))
                    fail(400, '검색 시즌을 확인해 주세요.');
                const unique = [...new Map(tags.map(t => [t.tier + ':' + t.season, t])).values()];
                if (unique.length) {
                    where.push((s.get('match') === 'all' ? '(SELECT COUNT(*)' : 'EXISTS (SELECT 1') + " FROM post_seasons s JOIN json_each(?) j ON s.tier=json_extract(j.value,'$.tier') AND s.season=json_extract(j.value,'$.season') WHERE s.post_id=p.id)" + (s.get('match') === 'all' ? '=' + unique.length : ''));
                    values.push(JSON.stringify(unique));
                }
            }
            const scope = s.get('scope');
            if (scope === 'favorites' || scope === 'recent') {
                if (!u)
                    fail(401, '로그인이 필요합니다.');
                where.push(`p.id IN(SELECT post_id FROM ${scope === 'favorites' ? 'favorites' : 'history'} WHERE user_id=?)`);
                values.push(u.id);
            }
            let order = s.get('sort') === 'price-low' ? 'p.price IS NULL,p.price ASC' : s.get('sort') === 'price-high' ? 'p.price IS NULL,p.price DESC' : 'p.created_at DESC';
            if (scope === 'recent') {
                order = '(SELECT created_at FROM history WHERE post_id=p.id AND user_id=?) DESC';
            }
            const clause = ' WHERE ' + where.join(' AND '), page = Math.max(1, Math.min(10000, Math.floor(Number(s.get('page')) || 1)));
            const r = await db().batch([db().prepare('SELECT COUNT(*) AS count FROM posts p' + clause).bind(...values), db().prepare(select + clause + ' ORDER BY ' + order + ',p.id DESC LIMIT 16 OFFSET ?').bind(...values, ...(scope === 'recent' ? [u!.id] : []), (page - 1) * 16)]);
            return json({ posts: await decorate(r[1].results, u?.id), total: (r[0].results[0] as any).count, page });
        }
        if (p[1] && method === 'GET') {
            const u = await currentUser(req), post = await visiblePost(p[1], u);
            return json({ post: (await decorate([post], u?.id))[0] });
        }
        const u = await requireUser(req);
        await limit('post:' + u.id, 50, 60000);
        const existing = p[1] ? await visiblePost(p[1], u) : null;
        if (p[2] === 'favorite' && method === 'POST') {
            if (!existing)
                fail(404, '게시글을 찾을 수 없습니다.');
            const b = await body(req);
            if (b.active)
                await db().prepare('INSERT OR IGNORE INTO favorites(user_id,post_id,created_at) VALUES(?,?,?)').bind(u.id, existing.id, Date.now()).run();
            else
                await db().prepare('DELETE FROM favorites WHERE user_id=? AND post_id=?').bind(u.id, existing.id).run();
            return json({ ok: true });
        }
        if (p[2] === 'view' && method === 'POST') {
            await db().batch([db().prepare('INSERT INTO history(user_id,post_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,post_id) DO UPDATE SET created_at=excluded.created_at').bind(u.id, existing.id, Date.now()), db().prepare('DELETE FROM history WHERE user_id=? AND post_id NOT IN(SELECT post_id FROM history WHERE user_id=? ORDER BY created_at DESC LIMIT 100)').bind(u.id, u.id)]);
            return json({ ok: true });
        }
        if (existing && existing.author_id !== u.id && (u.role !== 'manager' || method !== 'DELETE'))
            fail(403, '수정 또는 삭제 권한이 없습니다.');
        if (method === 'DELETE' && existing) {
            await db().prepare('DELETE FROM posts WHERE id=?').bind(existing.id).run();
            return json({ ok: true });
        }
        if (p[2] === 'status' && method === 'PATCH') {
            const b = await body(req);
            if (!['open', 'reserved', 'closed'].includes(b.status))
                fail(400, '거래 상태를 확인해 주세요.');
            await db().batch([db().prepare('UPDATE posts SET status=?,updated_at=? WHERE id=?').bind(b.status, Date.now(), existing.id), db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND ?!='reserved'").bind(Date.now(), existing.id, b.status)]);
            return json({ ok: true });
        }
        if (!['POST', 'PUT'].includes(method) || p[2])
            fail(405, '지원하지 않는 요청입니다.');
        if (method === 'POST' && p[1] || method === 'PUT' && !existing)
            fail(400, '게시글 번호를 확인해 주세요.');
        const v = await validatePost(await body(req), u, existing), now = Date.now();
        if (!existing) {
            const r = await db().batch([db().prepare('INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,accepts_offers,details,images,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(u.id, v.kind, v.title, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, now), ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES((SELECT id FROM posts WHERE author_id=? AND created_at=? ORDER BY id DESC LIMIT 1),?,?)').bind(u.id, now, t.tier, t.season))]);
            return json({ id: r[0].meta.last_row_id }, 201);
        }
        await db().batch([
            // D1 batches are transactional. Read the previous price inside the batch so
            // concurrent edits append the actual preceding price, never a stale client value.
            db().prepare("INSERT INTO post_price_history(post_id,price,changed_at) SELECT id,price,? FROM posts WHERE id=? AND kind='sell' AND ?='sell' AND price IS NOT NULL AND price IS NOT ?").bind(now, existing.id, v.kind, v.price),
            db().prepare('UPDATE posts SET kind=?,title=?,body=?,price=?,status=?,category=?,price_mode=?,accepts_offers=?,details=?,images=?,updated_at=? WHERE id=?').bind(v.kind, v.title, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, existing.id), db().prepare('DELETE FROM post_seasons WHERE post_id=?').bind(existing.id), ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)), db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND (?='closed' OR (?='reserved' AND ?!='reserved'))").bind(now, existing.id, v.status, existing.status, v.status)]);
        return json({ id: existing.id });
    }
    return await extras(req, p, url);
}
async function extras(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'uploads' && method === 'GET') {
        const u = await requireUser(req);
        const r = await db().prepare("SELECT id,size,created_at FROM uploads WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM posts p,json_each(p.images) j WHERE j.value=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE j.value=uploads.id) ORDER BY created_at DESC LIMIT 600").bind(u.id).all();
        return json({ uploads: r.results });
    }
    if (p[0] === 'uploads' && p[1] && method === 'DELETE') {
        const u = await requireUser(req);
        const r = await db().prepare("DELETE FROM uploads WHERE id=? AND owner_id=? AND NOT EXISTS(SELECT 1 FROM posts p,json_each(p.images) j WHERE j.value=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE j.value=uploads.id) RETURNING id").bind(p[1], u.id).first<any>();
        if (!r)
            fail(409, '사용 중이거나 삭제 권한이 없는 사진입니다.');
        await bucket().delete('uploads/' + r.id);
        return json({ ok: true });
    }
    if (p[0] === 'uploads' && method === 'POST') {
        const u = await requireUser(req);
        await limit('upload:' + u.id, 24, 600000);
        const count = await db().prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id=?').bind(u.id).first<any>();
        if (count.n >= 600)
            fail(409, '업로드 한도에 도달했습니다. 기존 사진을 정리해 주세요.');
        const declared = Number(req.headers.get('content-length'));
        if (declared > 5 * 1024 * 1024)
            fail(413, '사진 한 장은 5MB 이하여야 합니다.');
        const reader = req.body?.getReader();
        if (!reader)
            fail(400, '사진이 없습니다.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 5 * 1024 * 1024) {
                await reader.cancel();
                fail(413, '사진 한 장은 5MB 이하여야 합니다.');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
        }
        let mime = '';
        if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
            mime = 'image/jpeg';
        else if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10)
            mime = 'image/png';
        else if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP')
            mime = 'image/webp';
        if (!mime)
            fail(400, 'JPG, PNG, WebP 사진을 선택해 주세요.');
        const id = crypto.randomUUID();
        await bucket().put('uploads/' + id, bytes, { httpMetadata: { contentType: mime } });
        try {
            await db().prepare('INSERT INTO uploads(id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?)').bind(id, u.id, mime, size, Date.now()).run();
        }
        catch (e) {
            await bucket().delete('uploads/' + id);
            throw e;
        }
        return json({ id }, 201);
    }
    if (p[0] === 'images' && p[1] && method === 'GET') {
        const m = await db().prepare('SELECT * FROM uploads WHERE id=?').bind(p[1]).first<any>();
        if (!m)
            fail(404, '사진을 찾을 수 없습니다.');
        const publicImage = await db().prepare('SELECT 1 FROM posts p,json_each(p.images) j WHERE j.value=? AND p.hidden=0 LIMIT 1').bind(p[1]).first();
        if (!publicImage) {
            const u = await currentUser(req);
            if (u?.id !== m.owner_id && u?.role !== 'manager')
                fail(404, '사진을 찾을 수 없습니다.');
        }
        const obj = await bucket().get('uploads/' + p[1]);
        if (!obj)
            fail(404, '사진을 찾을 수 없습니다.');
        return new Response(obj.body, { headers: { 'Content-Type': m.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (p[0] === 'drafts') {
        const u = await requireUser(req), key = p[1] || 'new';
        if (!/^(new|\d+)$/.test(key))
            fail(400, '임시저장 위치를 확인해 주세요.');
        if (method === 'GET') {
            const d = await db().prepare('SELECT content,updated_at FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).first<any>();
            return json({ draft: d ? { ...parse(d.content, {}), savedAt: d.updated_at } : null });
        }
        if (method === 'PUT') {
            const b = await body(req);
            const count = await db().prepare('SELECT COUNT(*) AS n FROM drafts WHERE user_id=?').bind(u.id).first<any>();
            if (count.n >= 100 && !await db().prepare('SELECT 1 FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).first())
                fail(409, '임시저장이 너무 많습니다.');
            await db().prepare('INSERT INTO drafts(user_id,draft_key,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,draft_key) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at').bind(u.id, key, JSON.stringify(b), Date.now()).run();
            return json({ ok: true });
        }
        if (method === 'DELETE') {
            await db().prepare('DELETE FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'searches') {
        const u = await requireUser(req);
        if (method === 'GET') {
            const r = await db().prepare('SELECT id,name,query FROM saved_searches WHERE user_id=? ORDER BY created_at DESC').bind(u.id).all();
            return json({ searches: r.results });
        }
        if (method === 'POST') {
            const b = await body(req), name = textField(b.name, 1, 32, '검색 이름'), q = textField(b.query, 1, 12000, '검색 조건');
            const count = await db().prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id=?').bind(u.id).first<any>();
            if (count.n >= 20)
                fail(409, '검색은 최대 20개까지 저장할 수 있습니다.');
            await db().prepare('INSERT INTO saved_searches(id,user_id,name,query,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), u.id, name, q, Date.now()).run();
            return json({ ok: true });
        }
        if (method === 'DELETE' && p[1]) {
            await db().prepare('DELETE FROM saved_searches WHERE id=? AND user_id=?').bind(p[1], u.id).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'blocks') {
        const u = await requireUser(req);
        if (method === 'GET') {
            const r = await db().prepare('SELECT b.target_id,u.nickname FROM blocks b JOIN users u ON u.id=b.target_id WHERE b.user_id=?').bind(u.id).all();
            return json({ blocks: r.results });
        }
        if (method === 'POST') {
            const b = await body(req);
            if (typeof b.userId !== 'string' || b.userId === u.id)
                fail(400, '회원을 확인해 주세요.');
            if (!await db().prepare('SELECT id FROM users WHERE id=?').bind(b.userId).first())
                fail(404, '회원을 찾을 수 없습니다.');
            if (b.active)
                await db().prepare('INSERT OR IGNORE INTO blocks(user_id,target_id,created_at) VALUES(?,?,?)').bind(u.id, b.userId, Date.now()).run();
            else
                await db().prepare('DELETE FROM blocks WHERE user_id=? AND target_id=?').bind(u.id, b.userId).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'reports' && method === 'POST') {
        const u = await requireUser(req);
        await limit('report:' + u.id, 8, 3600000);
        const b = await body(req), post = await visiblePost(b.postId, u), reason = textField(b.reason, 2, 50, '신고 사유'), detail = textField(b.details, 1, 1000, '신고 설명');
        if (await db().prepare("SELECT id FROM reports WHERE post_id=? AND reporter_id=? AND status='pending'").bind(post.id, u.id).first())
            fail(409, '이미 접수한 신고가 검토 중입니다.');
        await db().prepare('INSERT INTO reports(post_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,?)').bind(post.id, u.id, reason, detail, Date.now()).run();
        return json({ ok: true });
    }
    if (p[0] === 'notices' && method === 'GET') {
        const r = await db().prepare('SELECT * FROM notices ORDER BY created_at DESC LIMIT 30').all();
        return json({ notices: r.results });
    }
    if (p[0] === 'manage') {
        const u = await requireUser(req);
        if (u.role !== 'manager')
            fail(403, '매니저만 접근할 수 있습니다.');
        if (method === 'GET') {
            const r = await db().batch([db().prepare('SELECT r.*,p.title,p.hidden,u.nickname FROM reports r LEFT JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 100'), db().prepare(select + ' WHERE p.hidden=1 ORDER BY p.updated_at DESC LIMIT 100')]);
            return json({ reports: r[0].results, hidden: await decorate(r[1].results, u.id) });
        }
        if (p[1] === 'visibility' && method === 'POST') {
            const b = await body(req);
            await db().batch([db().prepare('UPDATE posts SET hidden=?,updated_at=? WHERE id=?').bind(b.hidden ? 1 : 0, Date.now(), b.postId), db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND ?=1").bind(Date.now(), b.postId, b.hidden ? 1 : 0)]);
            return json({ ok: true });
        }
        if (p[1] === 'report' && method === 'POST') {
            const b = await body(req);
            await db().prepare('UPDATE reports SET status=? WHERE id=?').bind(b.status === 'pending' ? 'pending' : 'resolved', b.id).run();
            return json({ ok: true });
        }
        if (p[1] === 'notice') {
            if (method === 'DELETE' && p[2]) {
                await db().prepare('DELETE FROM notices WHERE id=?').bind(p[2]).run();
                return json({ ok: true });
            }
            if (method === 'POST' || method === 'PUT') {
                const b = await body(req), title = textField(b.title, 2, 100, '공지 제목'), content = textField(b.body, 1, 10000, '공지 내용');
                if (method === 'PUT' && p[2])
                    await db().prepare('UPDATE notices SET title=?,body=?,updated_at=? WHERE id=?').bind(title, content, Date.now(), p[2]).run();
                else
                    await db().prepare('INSERT INTO notices(title,body,created_at,updated_at) VALUES(?,?,?,?)').bind(title, content, Date.now(), Date.now()).run();
                return json({ ok: true });
            }
        }
    }
    if (p[0] === 'offers') {
        const u = await requireUser(req);
        if (method === 'GET') {
            const r = await db().prepare('SELECT o.*,p.title,p.hidden,s.nickname AS sender_name,t.nickname AS recipient_name FROM offers o JOIN posts p ON p.id=o.post_id JOIN users s ON s.id=o.sender_id JOIN users t ON t.id=o.recipient_id WHERE o.sender_id=? OR o.recipient_id=? ORDER BY o.created_at DESC LIMIT 100').bind(u.id, u.id).all();
            return json({ offers: r.results });
        }
        if (method === 'POST' && !p[1]) {
            await limit('offer:' + u.id, 20, 600000);
            const b = await body(req), post = await visiblePost(b.postId, u);
            if (post.hidden || post.status !== 'open')
                fail(409, '현재 가격 제안을 받지 않는 글입니다.');
            if (!post.accepts_offers && post.price_mode !== 'offer')
                fail(400, '작성자가 가격 제안을 받지 않습니다.');
            if (post.author_id === u.id)
                fail(400, '내 글에는 제안할 수 없습니다.');
            const n = amount(b.amount, false), note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : '';
            if (await db().prepare("SELECT id FROM offers WHERE post_id=? AND sender_id=? AND status='pending'").bind(post.id, u.id).first())
                fail(409, '대기 중인 제안을 먼저 철회해 주세요.');
            const chat = await ensureChat(u.id, post.author_id), id = crypto.randomUUID(), now = Date.now();
            const result = await db().batch([db().prepare("INSERT INTO offers(id,post_id,sender_id,recipient_id,conversation_id,amount,note,created_at,updated_at) SELECT ?,p.id,?,p.author_id,?,?,?,?,? FROM posts p WHERE p.id=? AND p.hidden=0 AND p.status='open' AND (p.accepts_offers=1 OR p.price_mode='offer') AND NOT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=p.author_id) OR (target_id=? AND user_id=p.author_id)) AND NOT EXISTS(SELECT 1 FROM offers WHERE post_id=p.id AND sender_id=? AND status='pending')").bind(id, u.id, chat, n, note, now, now, post.id, u.id, u.id, u.id), db().prepare("INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,created_at) SELECT ?,?,?,'offer',?,? WHERE EXISTS(SELECT 1 FROM offers WHERE id=?)").bind(chat, u.id, '가격 제안', id, now, id), db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, chat)]);
            if (!result[0].meta.changes)
                fail(409, '제안이 이미 있거나 거래 조건이 바뀌었습니다.');
            return json({ id, chatId: chat }, 201);
        }
        if (method === 'PATCH' && p[1]) {
            const b = await body(req), offer = await db().prepare('SELECT * FROM offers WHERE id=? AND (sender_id=? OR recipient_id=?)').bind(p[1], u.id, u.id).first<any>();
            if (!offer)
                fail(404, '제안을 찾을 수 없습니다.');
            if (offer.status !== 'pending')
                fail(409, '이미 처리된 제안입니다.');
            const action = b.action;
            if (!['accepted', 'declined', 'withdrawn'].includes(action))
                fail(400, '제안 처리 방식을 확인해 주세요.');
            if (action === 'withdrawn' ? offer.sender_id !== u.id : offer.recipient_id !== u.id)
                fail(403, '제안 처리 권한이 없습니다.');
            if (action === 'accepted' && await blocked(offer.sender_id, offer.recipient_id))
                fail(403, '차단된 회원의 제안은 수락할 수 없습니다.');
            const now = Date.now();
            if (action === 'accepted') {
                const r = await db().batch([db().prepare("UPDATE offers SET status='accepted',updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM posts WHERE id=offers.post_id AND status='open' AND hidden=0) AND NOT EXISTS(SELECT 1 FROM offers x WHERE x.post_id=offers.post_id AND x.status='accepted')").bind(now, offer.id), db().prepare("UPDATE posts SET status='reserved',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM offers WHERE id=? AND status='accepted')").bind(now, offer.post_id, offer.id), db().prepare("UPDATE offers SET status='declined',updated_at=? WHERE post_id=? AND status='pending' AND EXISTS(SELECT 1 FROM offers x WHERE x.id=? AND x.status='accepted')").bind(now, offer.post_id, offer.id)]);
                if (!r[0].meta.changes)
                    fail(409, '다른 제안이 처리되었거나 거래 상태가 바뀌었습니다.');
            }
            else {
                const r = await db().prepare("UPDATE offers SET status=?,updated_at=? WHERE id=? AND status='pending'").bind(action, now, offer.id).run();
                if (!r.meta.changes)
                    fail(409, '이미 처리된 제안입니다.');
            }
            return json({ ok: true });
        }
    }
    if (p[0] === 'chats') {
        const u = await requireUser(req);
        if (!p[1] && method === 'GET') {
            const r = await db().prepare(`SELECT c.id,c.updated_at,u.id AS partner_id,u.nickname,u.role,(SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,(SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND sender_id!=? AND read_at IS NULL) AS unread FROM conversations c JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END WHERE c.user_a=? OR c.user_b=? ORDER BY c.updated_at DESC`).bind(u.id, u.id, u.id, u.id).all();
            return json({ chats: r.results });
        }
        if (!p[1] && method === 'POST') {
            await limit('chat-new:' + u.id, 30, 60000);
            const b = await body(req);
            if (typeof b.userId !== 'string')
                fail(400, '회원을 확인해 주세요.');
            let post: any;
            if (b.postId) {
                post = await visiblePost(b.postId, u);
                if (post.author_id !== b.userId)
                    fail(400, '게시글 작성자를 확인해 주세요.');
            }
            const id = await ensureChat(u.id, b.userId);
            if (post) {
                const exists = await db().prepare("SELECT id FROM messages WHERE conversation_id=? AND type='listing' AND reference_id=?").bind(id, String(post.id)).first();
                if (!exists)
                    await db().batch([db().prepare("INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,created_at) VALUES(?,?,?,'listing',?,?)").bind(id, u.id, post.title, String(post.id), Date.now()), db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(Date.now(), id)]);
            }
            return json({ id });
        }
        if (p[1] && p[2] === 'messages') {
            const c = await chatMember(p[1], u.id);
            if (method === 'GET') {
                const after = url.searchParams.has('after'), cursor = after ? (Number(url.searchParams.get('after')) || 0) : (Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER);
                const r = await db().prepare('SELECT id,sender_id,body,type,reference_id,created_at,read_at FROM messages WHERE conversation_id=? AND id' + (after ? '>' : '<') + '? ORDER BY id ' + (after ? 'ASC' : 'DESC') + ' LIMIT 100').bind(p[1], cursor).all();
                const seen = await db().prepare('SELECT MAX(id) AS last_id FROM messages WHERE conversation_id=? AND sender_id=? AND read_at IS NOT NULL').bind(p[1], u.id).first<any>();
                const offers = await db().prepare('SELECT o.*,p.title FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.conversation_id=?').bind(p[1]).all();
                return json({ messages: after ? r.results : r.results.reverse(), offers: offers.results, hasMore: r.results.length === 100, readThrough: seen?.last_id || 0, blocked: await blocked(c.user_a, c.user_b) });
            }
            if (method === 'POST') {
                if (await blocked(c.user_a, c.user_b))
                    fail(403, '차단된 회원과는 메시지를 주고받을 수 없습니다.');
                await limit('message:' + u.id, 60, 60000);
                const b = await body(req), content = textField(b.body, 1, 2000, '메시지'), now = Date.now();
                const r = await db().batch([db().prepare('INSERT INTO messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)').bind(p[1], u.id, content, now), db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, p[1])]);
                return json({ id: r[0].meta.last_row_id }, 201);
            }
        }
        if (p[1] && p[2] === 'read' && method === 'POST') {
            await chatMember(p[1], u.id);
            const b = await body(req);
            if (!Number.isSafeInteger(b.lastId))
                fail(400, '메시지 번호를 확인해 주세요.');
            await db().prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL AND id<=?').bind(Date.now(), p[1], u.id, b.lastId).run();
            return json({ ok: true });
        }
    }
    return null;
}
