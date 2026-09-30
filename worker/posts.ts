import { db, fail, currentUser, requireUser, json, body, limit, textField, memberColumns, withMember, setting } from './http';
import {
    CATEGORIES, TRADE_KINDS, DETAIL_FIELDS, BUYER_DETAIL_FIELDS, ACCOUNT_CHOICES, RECORD_PREFERENCES, NICK_RANKS, SKIN_TAGS,
    FULL_SET, LEGACY_SKELETON, LATEST_SEASON, categoriesForKind, normalizeTrade, validTags, choiceAllowed,
    type DetailField, type SeasonTag, type User,
} from '../shared/market';

export const postSelect = `SELECT p.*,u.nickname,u.role,${memberColumns('u', 'author_')} FROM posts p JOIN users u ON u.id=p.author_id`;

export const parse = (s: string, fallback: any) => { try { return JSON.parse(s); } catch { return fallback; } };

export async function latestSeason() {
    const v = Number(await setting('latest_season'));
    return Number.isInteger(v) && v >= LATEST_SEASON && v <= 200 ? v : LATEST_SEASON;
}

async function rawPost(id: string | number) { return db().prepare(postSelect + ' WHERE p.id=?').bind(id).first<any>(); }

export async function visiblePost(id: string | number, u: User | null) {
    const p = await rawPost(id);
    if (!p || p.hidden && p.author_id !== u?.id && u?.role !== 'manager') fail(404, '게시글을 찾을 수 없습니다.');
    return p;
}

export async function decorate(rows: any[], uid?: string) {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map(p => p.id));
    const [tags, favs, histories] = await db().batch([
        db().prepare('SELECT post_id,tier,season FROM post_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id FROM favorites WHERE user_id=? AND post_id IN (SELECT value FROM json_each(?))').bind(uid || '', ids),
        db().prepare('SELECT post_id,price,changed_at FROM post_price_history WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(ids),
    ]);
    return rows.map(row => {
        const p = withMember(row, 'author_');
        return {
            ...p, ...normalizeTrade(p.kind, p.category),
            price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
            details: parse(p.details, {}), images: parse(p.images, []),
            tags: tags.results.filter((t: any) => t.post_id === p.id).map((t: any) => ({ tier: t.tier, season: t.season })),
            favorite: favs.results.some((f: any) => f.post_id === p.id),
            price_history: p.kind === 'sell' ? histories.results.filter((h: any) => h.post_id === p.id).map((h: any) => ({ price: h.price, changed_at: h.changed_at })) : [],
        };
    });
}

export function amount(v: any, optional = true) {
    if (v === null || v === '' || v === undefined) {
        if (optional) return null;
        fail(400, '가격을 입력해 주세요.');
    }
    if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !/^\d+$/.test(v.trim()))) fail(400, '가격은 숫자로 입력해 주세요.');
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) fail(400, '가격은 0~10억 원의 정수로 입력해 주세요.');
    return n;
}

function numericDetail(details: Record<string, string>, key: string, label: string, min: number, max: number) {
    if (!details[key]) return;
    if (!/^\d+$/.test(details[key]) || Number(details[key]) < min || Number(details[key]) > max) fail(400, `${label}은 ${min}~${max} 사이의 정수로 입력해 주세요.`);
    details[key] = String(Number(details[key]));
}

function selectedDetails(details: Record<string, string>, key: string, allowed: readonly string[], label: string, includeLegacySet = false) {
    if (!details[key]) return;
    const chosen = parse(details[key], null);
    if (!Array.isArray(chosen) || chosen.length > allowed.length || chosen.some(v => typeof v !== 'string' || !allowed.includes(v))) fail(400, `${label}을 확인해 주세요.`);
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
    // 대리(진행) is limited to members with 대리 인증. Existing posts keep their kind.
    if (b.kind === 'proxy_offer' && existing?.kind !== 'proxy_offer' && u.role !== 'manager' && !u.badges.includes('proxy'))
        fail(403, '대리(진행) 글은 대리 인증을 받은 회원만 올릴 수 있습니다.');
    if (!validTags(b.tags, await latestSeason())) fail(400, '티어와 시즌을 확인해 주세요.');
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
            if (details[key] && !choiceAllowed(key, details[key])) fail(400, `${f.label}을 확인해 주세요.`);
        }
        numericDetail(details, 'ownerCount', '대주 수', 1, 9999);
        numericDetail(details, 'nicknameChars', '닉 글자 수', 1, 20);
        numericDetail(details, 'phantom', '팬텀 %', 0, 5000);
        selectedDetails(details, 'skinTags', SKIN_TAGS, '스킨 선택', true);
    }
    if (category === 'account' && b.kind === 'buy') validateBuyerDetails(details);
    if (b.kind === 'exchange' && details.wantedCategory === 'account') validateBuyerDetails(details, 'wanted');
    if (details.currentOffer) details.currentOffer = String(amount(details.currentOffer, false));
    // This retired free-text field has no input anymore. Keep the seller's original data on edits.
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

async function listPosts(req: Request, url: URL) {
    const u = await currentUser(req), s = url.searchParams, where = ['p.hidden=0'], values: any[] = [];
    for (const [param, col, allowed] of [['kind', 'kind', TRADE_KINDS], ['category', 'category', CATEGORIES.map(c => c.id)], ['status', 'status', ['open', 'reserved', 'closed']]] as [string, string, string[]][]) {
        const v = s.get(param);
        if (v && allowed.includes(v)) { where.push('p.' + col + '=?'); values.push(v); }
    }
    if (s.get('author')) { where.push('p.author_id=?'); values.push(s.get('author')); }
    if (s.get('active') === '1') where.push("p.status!='closed'");
    if (s.get('mode') && ['fixed', 'offer', 'negotiate'].includes(s.get('mode')!)) {
        where.push("(CASE WHEN p.price_mode='legacy' THEN CASE WHEN p.price IS NULL THEN 'negotiate' ELSE 'fixed' END ELSE p.price_mode END)=?");
        values.push(s.get('mode'));
    }
    const q = s.get('q')?.trim().slice(0, 100);
    if (q) {
        where.push("(instr(lower(p.title),lower(?))>0 OR instr(lower(p.body),lower(?))>0 OR instr(lower(replace(p.details,' ','')),lower(replace(?,' ','')))>0 OR instr(lower(u.nickname),lower(?))>0)");
        values.push(q, q, q, q);
    }
    for (const [key, op] of [['min', '>='], ['max', '<=']]) {
        const n = s.get(key);
        if (n !== null && n !== '') { where.push('p.price' + op + '?'); values.push(amount(n, false)); }
    }
    for (const [key, path] of [['level', 'level'], ['skins', 'humanSkins'], ['gas', 'gas'], ['minerals', 'minerals'], ['phantom', 'phantom']]) {
        const v = s.get(key);
        if (v) { where.push(`CAST(json_extract(p.details,'$.${path}') AS INTEGER)>=?`); values.push(amount(v, false)); }
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
    if (maxOwners !== null) { where.push("CAST(json_extract(p.details,'$.ownerCount') AS INTEGER)<=?"); values.push(maxOwners); }
    const ownerCountOfMine = queryInteger('ownerCountOfMine', 1, 9999);
    if (ownerCountOfMine !== null) { where.push("(json_extract(p.details,'$.maxOwners') IS NULL OR CAST(json_extract(p.details,'$.maxOwners') AS INTEGER)>=?)"); values.push(ownerCountOfMine); }
    for (const [key, f] of Object.entries(ACCOUNT_CHOICES)) {
        const v = s.get(key);
        if (!v) continue;
        if (!choiceAllowed(key, v)) fail(400, `${f.label} 검색 조건을 확인해 주세요.`);
        if (buying && key === 'nicknameRank') where.push("(json_array_length(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]'))=0 OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]')) WHERE value=?))");
        else where.push(`json_extract(p.details,'$.${key}')=?`);
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
        if (!validTags(tags, await latestSeason())) fail(400, '검색 시즌을 확인해 주세요.');
        const unique = [...new Map(tags.map(t => [t.tier + ':' + t.season, t])).values()];
        if (unique.length) {
            const all = s.get('match') === 'all';
            where.push((all ? '(SELECT COUNT(*)' : 'EXISTS (SELECT 1') + " FROM post_seasons s JOIN json_each(?) j ON s.tier=json_extract(j.value,'$.tier') AND s.season=json_extract(j.value,'$.season') WHERE s.post_id=p.id)" + (all ? '=' + unique.length : ''));
            values.push(JSON.stringify(unique));
        }
    }
    const badge = s.get('badge');
    if (badge && ['proxy', 'identity', 'credit'].includes(badge)) {
        where.push('EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge=?)');
        values.push(badge);
    }
    const scope = s.get('scope');
    if (scope === 'favorites' || scope === 'recent') {
        if (!u) fail(401, '로그인이 필요합니다.');
        where.push(`p.id IN(SELECT post_id FROM ${scope === 'favorites' ? 'favorites' : 'history'} WHERE user_id=?)`);
        values.push(u.id);
    }
    let order = s.get('sort') === 'price-low' ? 'p.price IS NULL,p.price ASC' : s.get('sort') === 'price-high' ? 'p.price IS NULL,p.price DESC' : 'p.created_at DESC';
    if (scope === 'recent') order = '(SELECT created_at FROM history WHERE post_id=p.id AND user_id=?) DESC';
    const size = Math.max(1, Math.min(40, Math.floor(Number(s.get('size')) || 16)));
    const clause = ' WHERE ' + where.join(' AND '), page = Math.max(1, Math.min(10000, Math.floor(Number(s.get('page')) || 1)));
    const r = await db().batch([
        db().prepare('SELECT COUNT(*) AS count FROM posts p JOIN users u ON u.id=p.author_id' + clause).bind(...values),
        db().prepare(postSelect + clause + ' ORDER BY ' + order + ',p.id DESC LIMIT ? OFFSET ?').bind(...values, ...(scope === 'recent' ? [u!.id] : []), size, (page - 1) * size),
    ]);
    return json({ posts: await decorate(r[1].results, u?.id), total: (r[0].results[0] as any).count, page, size });
}

export async function postsHandler(req: Request, p: string[], url: URL): Promise<Response> {
    const method = req.method;
    if (method === 'GET' && !p[1]) return listPosts(req, url);
    if (p[1] && method === 'GET' && !p[2]) {
        const u = await currentUser(req), post = await visiblePost(p[1], u);
        return json({ post: (await decorate([post], u?.id))[0] });
    }
    const u = await requireUser(req);
    await limit('post:' + u.id, 50, 60000);
    const existing = p[1] ? await visiblePost(p[1], u) : null;
    if (p[2] === 'favorite' && method === 'POST') {
        const b = await body(req);
        if (b.active) await db().prepare('INSERT OR IGNORE INTO favorites(user_id,post_id,created_at) VALUES(?,?,?)').bind(u.id, existing.id, Date.now()).run();
        else await db().prepare('DELETE FROM favorites WHERE user_id=? AND post_id=?').bind(u.id, existing.id).run();
        return json({ ok: true });
    }
    if (p[2] === 'view' && method === 'POST') {
        await db().batch([
            db().prepare('INSERT INTO history(user_id,post_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,post_id) DO UPDATE SET created_at=excluded.created_at').bind(u.id, existing.id, Date.now()),
            db().prepare('DELETE FROM history WHERE user_id=? AND post_id NOT IN(SELECT post_id FROM history WHERE user_id=? ORDER BY created_at DESC LIMIT 100)').bind(u.id, u.id),
        ]);
        return json({ ok: true });
    }
    if (existing && existing.author_id !== u.id && (u.role !== 'manager' || method !== 'DELETE')) fail(403, '수정 또는 삭제 권한이 없습니다.');
    if (method === 'DELETE' && existing) {
        await db().prepare('DELETE FROM posts WHERE id=?').bind(existing.id).run();
        return json({ ok: true });
    }
    if (p[2] === 'status' && method === 'PATCH') {
        const b = await body(req);
        if (!['open', 'reserved', 'closed'].includes(b.status)) fail(400, '거래 상태를 확인해 주세요.');
        await db().batch([
            db().prepare('UPDATE posts SET status=?,updated_at=? WHERE id=?').bind(b.status, Date.now(), existing.id),
            db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND ?!='reserved'").bind(Date.now(), existing.id, b.status),
        ]);
        return json({ ok: true });
    }
    if (!['POST', 'PUT'].includes(method) || p[2]) fail(405, '지원하지 않는 요청입니다.');
    if (method === 'POST' && p[1] || method === 'PUT' && !existing) fail(400, '게시글 번호를 확인해 주세요.');
    const v = await validatePost(await body(req), u, existing), now = Date.now();
    if (!existing) {
        const r = await db().batch([
            db().prepare('INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,accepts_offers,details,images,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
                .bind(u.id, v.kind, v.title, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, now),
            ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES((SELECT id FROM posts WHERE author_id=? AND created_at=? ORDER BY id DESC LIMIT 1),?,?)').bind(u.id, now, t.tier, t.season)),
        ]);
        return json({ id: r[0].meta.last_row_id }, 201);
    }
    await db().batch([
        // D1 batches are transactional. Read the previous price inside the batch so
        // concurrent edits append the actual preceding price, never a stale client value.
        db().prepare("INSERT INTO post_price_history(post_id,price,changed_at) SELECT id,price,? FROM posts WHERE id=? AND kind='sell' AND ?='sell' AND price IS NOT NULL AND price IS NOT ?").bind(now, existing.id, v.kind, v.price),
        db().prepare('UPDATE posts SET kind=?,title=?,body=?,price=?,status=?,category=?,price_mode=?,accepts_offers=?,details=?,images=?,updated_at=? WHERE id=?')
            .bind(v.kind, v.title, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, existing.id),
        db().prepare('DELETE FROM post_seasons WHERE post_id=?').bind(existing.id),
        ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)),
        db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND (?='closed' OR (?='reserved' AND ?!='reserved'))").bind(now, existing.id, v.status, existing.status, v.status),
    ]);
    return json({ id: existing.id });
}
