import { Suspense, lazy, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Lock, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    ACCOUNT_CHOICES, DETAIL_FIELDS, KIND_ICONS, KIND_NAMES, NICK_RANKS, NICK_TYPES, PHANTOM_HINT, PHANTOM_LABEL, PHANTOM_MAX, RARE_NICK_HINT, RECORD_PREFERENCES, TRADE_KINDS,
    categoriesForKind, categoryName, choiceLabel, featureTags, isProxyKind, isTradeKind, manToWon, normalizeTrade, parseList, skinTags, suspendUntilText, wonToMan,
    type DetailField, type Post, type SeasonTag, type TradeKind,
} from '../../shared/market';
import { SITE_RULES, linkPreviewAllowed } from '../../shared/membership';
import { validHidden, type LadderHidden } from '../../shared/ladder';
import { findLinks } from '../../shared/links';
import { encodeStyle, normalizeMarks, shiftOnEdit, styleRank, type Mark } from '../../shared/richtext';
import { ApiError, api, dragsFiles, errorText, fileHash, imageFiles, lookupPhotos, makeThumb, pastesText, sendPhoto, UPLOAD_BUSY, type UsedIn } from '../lib/api';
import { navigate, setLeaveGuard, useLocation } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, Modal, SkeletonRows } from '../components/ui';
import { kstClock as readyClock, walletNow, type Usage } from '../components/Wallet';
import { SameListingSheet, type Dup } from '../components/SameListingSheet';
import { PhotoGrid } from '../components/PhotoGrid';
import { ClanTierPicker, IntegerInput, NickTypePicker, RankPicker, SeasonPicker, Segmented, SkinPicker, TagInput } from '../components/Pickers';

// 글자 꾸미기 sheet (WP49), loaded when first opened.
const StyleSheet = lazy(() => import('../components/StyleSheet'));

type Form = {
    kind: TradeKind; category: string; title: string; body: string;
    price: string; // 만원
    offer: string; // 현젯, 만원
    accepts_offers: boolean; status: string; tags: SeasonTag[]; details: Record<string, string>; images: string[];
    wantedTags: SeasonTag[]; // ladders an exchange post wants in return
    ladderHidden: LadderHidden; // 시즌 비공개 (WP68): 판매 and the offered side of 교환 only
    clanTags: SeasonTag[]; // 클랜 래더 (WP70): the clan's own seasons on clan posts (구매: the wanted ones)
    wantedClanTags: SeasonTag[]; // the clan ladder an exchange wants for a clan
    link_preview: boolean; // 링크 미리보기 (WP48), on by default; drafts carry it
    body_style: Mark[]; // 글자 꾸미기 (WP49): ranges over body, shifted as it is typed; drafts carry them
};

const blank: Form = { kind: 'sell', category: 'account', title: '', body: '', price: '', offer: '', accepts_offers: true, status: 'open', tags: [], details: {}, images: [], wantedTags: [], ladderHidden: {}, clanTags: [], wantedClanTags: [], link_preview: true, body_style: [] };
// 시즌 비공개 goes with 판매 and the offered side of 교환, on account posts only (the server refuses it elsewhere).
const holdsHidden = (f: Pick<Form, 'kind' | 'category'>) => (f.kind === 'sell' || f.kind === 'exchange') && f.category === 'account';

function normalize(raw: Partial<Form>): Form {
    const t = normalizeTrade(raw.kind || 'sell', raw.category || 'account');
    const cats = categoriesForKind(t.kind);
    const form: Form = { ...blank, ...raw, kind: t.kind, category: cats.some(c => c.id === t.category) ? t.category : cats[0].id, details: { ...(raw.details || {}) }, tags: raw.tags || [], images: raw.images || [], wantedTags: raw.wantedTags || [], ladderHidden: validHidden(raw.ladderHidden) || {}, clanTags: raw.clanTags || [], wantedClanTags: raw.wantedClanTags || [] };
    form.body_style = normalizeMarks(form.body, Array.isArray(raw.body_style) ? raw.body_style : []);
    if (form.kind === 'exchange') { form.price = ''; form.details.wantedCategory = form.details.wantedCategory === 'clan' ? 'clan' : 'account'; }
    return form;
}

function fromPost(p: Post): Form {
    const { currentOffer, ...details } = p.details;
    return normalize({ kind: p.kind, category: p.category, title: p.title, body: p.body, price: wonToMan(p.price), offer: currentOffer ? wonToMan(Number(currentOffer)) : '', accepts_offers: !!p.accepts_offers, status: p.status, tags: p.tags, details, images: p.images, wantedTags: p.wanted_tags || [], ladderHidden: p.ladder_hidden || {}, clanTags: p.clan_tags || [], wantedClanTags: p.wanted_clan_tags || [], link_preview: p.link_preview !== false, body_style: p.body_style?.m || [] });
}

function template(kind: TradeKind, category: string) {
    if (kind === 'exchange') return '내놓는 것:\n원하는 것:\n추금: 받음 / 드림 / 없음\n';
    if (kind === 'proxy_request') return '종목:\n현재 -> 목표:\n가능 시간:\n';
    if (kind === 'proxy_offer') return '가능 종목:\n가격: (예: 천점당 0.7)\n경력: (예: 30 챌린저, 31 마스터)\n조건: (예: 선입금, 동접 시 중단)\n';
    if (kind === 'buy') return '필수:\n우대:\n거래 방법:\n';
    if (category === 'account') return '스킨/악세:\n라이드/펫:\n엠블럼:\n거래 방법: (쿨거, 전비변 바로 등)\n';
    return '내용:\n거래 방법:\n';
}

// Title examples per board, written the way cafe titles are (5렙 공백클랜, 코믹스 1권 미쿺, 은하고 올클, 래더 대리·서폿).
// Exchange is keyed by 내놓는 대상:구하는 대상 and follows the board's '[계정|클랜]에서 [계정|클랜] 구함'.
const TITLE_EXAMPLES: Record<TradeKind, Record<string, string>> = {
    sell: { account: '예: 28 챌린저 2대주 계정 팝니다', clan: '예: 5렙 공백클랜 팝니다', goods_coupon: '예: 코믹스 1권 미쿺 팝니다', other: '예: 기여 용병 합니다' },
    buy: { account: '예: 3대주 이하 무전적 계정 구합니다', clan: '예: 5렙 이상 공백클랜 구합니다', goods_coupon: '예: 유루미 스쿺 구합니다', other: '예: 기여 용병 구합니다' },
    exchange: {
        'account:account': '예: 2글자 닉 계정에서 래더계 구함', 'account:clan': '예: 래더계에서 5렙 공백클랜 구함',
        'clan:account': '예: 5렙 공백클랜에서 계정 구함', 'clan:clan': '예: 5렙 공백클랜에서 10렙 클랜 구함',
    },
    proxy_request: { ladder: '예: 32시즌 다이아 래더 대리 구합니다', story: '예: 은하고 올클 대리 구합니다', event: '예: 이벤트 코인 대리 구합니다' },
    proxy_offer: { ladder: '예: 32시즌 래더 대리·서폿 합니다', story: '예: 마법고 대리 합니다', event: '예: 이벤트 코인 대리 합니다' },
};

function titlePlaceholder(kind: TradeKind, category: string, wanted: string) {
    return TITLE_EXAMPLES[kind][kind === 'exchange' ? category + ':' + wanted : category] || '';
}

// Body hints mirror each board's 양식; the clan and goods hints skip what their fields already ask (레벨, 인원, 상태, 거래 방법).
function bodyPlaceholder(kind: TradeKind, category: string) {
    if (kind === 'buy') return '필수, 우대 조건 등';
    if (kind === 'exchange') return '원하는 조건, 추금 등';
    if (kind === 'proxy_request') return '종목, 현재 -> 목표, 가능 시간 등';
    if (kind === 'proxy_offer') return '가격, 경력, 진행 조건 등';
    return ({ account: '스킨, 악세, 라이드, 거래 방법 등', clan: '순위, 기여, 거래 방법 등', goods_coupon: '구성, 특이 사항 등' } as Record<string, string>)[category] || '상태, 거래 방법 등';
}

// The 판매 board filtered like the post being written: same category and ladder seasons, completed posts.
function similarHref(category: string, tags: SeasonTag[]) {
    const q = new URLSearchParams({ kind: 'sell', category });
    if (category === 'account' && tags.length) q.set('tags', JSON.stringify(tags.map(t => ({ tier: t.tier, season: t.season }))));
    q.set('closed', 'only');
    return '/trade?' + q.toString();
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
    return <section className="ed-section"><div className="ed-head"><h2>{title}</h2>{desc && <p>{desc}</p>}</div>{children}</section>;
}

// A folded part that opens by itself when it already holds a value; after the first toggle the
// member's choice wins, so clearing the last value never snaps it shut while typing.
function Fold({ filled, className = 'ed-more', summary, children }: { filled: boolean; className?: string; summary: ReactNode; children: ReactNode }) {
    const [open, setOpen] = useState<boolean | null>(null);
    return <details className={className} open={open ?? filled} onToggle={e => setOpen(e.currentTarget.open)}><summary>{summary}</summary>{children}</details>;
}

function Num({ label, value, onChange, unit, max = 1000000000, placeholder = '', decimal = false, error = '', id, hint }: { label: string; value: string; onChange: (v: string) => void; unit?: string; max?: number; placeholder?: string; decimal?: boolean; error?: string; id?: string; hint?: string }) {
    const errorId = id ? id + '-error' : undefined;
    return <label className="field"><span className="field-label">{label}</span>
        <div className={unit ? 'input-unit' : undefined}>
            {/* Whole numbers drop separators (1,400,000) and keep only their leading digits (2.5 leaves 2, not 25). */}
            {decimal
                ? <input id={id} className="input" placeholder={placeholder} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                    type="number" inputMode="decimal" min="0" max={max} step="any" onChange={e => onChange(e.target.value)} />
                : <IntegerInput id={id} className="input" placeholder={placeholder} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                    max={max} onChange={onChange} />}
            {unit && <span>{unit}</span>}
        </div>
        {/* 만원 fields show the amount in 원; a whole number of five digits or more (미네랄) shows its separators. */}
        {error ? <span className="field-error" id={errorId} role="alert">{error}</span>
            : decimal ? value && !Number.isNaN(manToWon(value)) && manToWon(value) !== null && <span className="field-hint">{manToWon(value)!.toLocaleString('ko-KR')}원</span>
            : value.length >= 5 ? <span className="field-hint">{Number(value).toLocaleString('ko-KR')}</span>
            : hint && <span className="field-hint">{hint}</span>}
    </label>;
}

// Switching 거래 구분 keeps what the new kind shows the same way: 판매 and the offered side of
// 교환 share the account (or clan) fields and the ladder record. Everything else starts empty.
function forKind(f: Form, kind: TradeKind): Form {
    const cats = categoriesForKind(kind);
    const category = cats.some(c => c.id === f.category) ? f.category : cats[0].id;
    const shared = category === f.category && ((f.kind === 'sell' && kind === 'exchange') || (f.kind === 'exchange' && kind === 'sell'));
    const details: Record<string, string> = shared ? Object.fromEntries(Object.entries(f.details).filter(([k]) => !k.startsWith('wanted'))) : {};
    if (kind === 'exchange') details.wantedCategory = 'account';
    return { ...f, kind, category, price: '', offer: '', tags: shared ? f.tags : [], wantedTags: [], ladderHidden: shared ? f.ladderHidden : {}, clanTags: shared ? f.clanTags : [], wantedClanTags: [], details };
}
function dropsInput(f: Form, next: Form) {
    return Object.entries(f.details).some(([k, v]) => k !== 'wantedCategory' && !!v && next.details[k] !== v)
        || (f.tags.length > 0 && next.tags !== f.tags) || (f.wantedTags.length > 0 && next.wantedTags !== f.wantedTags)
        || (Object.keys(f.ladderHidden).length > 0 && next.ladderHidden !== f.ladderHidden)
        || (f.clanTags.length > 0 && next.clanTags !== f.clanTags) || (f.wantedClanTags.length > 0 && next.wantedClanTags !== f.wantedClanTags);
}

// '15:40' on the Korean clock.
function kstClock(t: number) {
    const d = new Date(t + 9 * 3600000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

type Draft = Partial<Form> & { savedAt?: number };
// Photos per post (the same for every member; SITE_RULES.photosPerPost) until GET me/usage answers.
const PHOTO_CAP = SITE_RULES.photosPerPost;
const EXCHANGE_SIDES = ['account', 'clan'] as const;
const PROXY_MORE_KEYS = ['mode', 'current', 'target', 'schedule', 'duration', 'conditions'];
const ACCOUNT_MORE_KEYS = ['integrated', 'passwordChange', 'phoneChange', 'backupEmail', 'level', 'labLevel', 'humanSkins', 'zombieSkins', 'closet'];

export default function Editor({ id }: { id?: string }) {
    const { me, ready, requireLogin, openApply, refreshMe } = useApp();
    const { params } = useLocation();
    const proxyAllowed = me?.role === 'manager' || !!me?.badges.includes('proxy');
    // A link to a 대리(진행) form without 대리 인증 opens 대리(구함) instead and offers the application.
    const proxyBlocked = !id && params.get('kind') === 'proxy_offer' && !!me && !proxyAllowed;
    const urlKind = isTradeKind(params.get('kind'));
    const [initial] = useState(() => normalize({
        kind: proxyBlocked ? 'proxy_request' : urlKind ? params.get('kind') as TradeKind : 'sell',
        category: params.get('category') || undefined,
        details: params.get('kind') === 'exchange' ? { wantedCategory: params.get('wantedCategory') === 'clan' ? 'clan' : 'account' } : {},
    }));
    const [form, setForm] = useState<Form>(initial);
    const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState('');
    // 'loaded': a draft is on screen ('새로 쓰기' starts over). 'offer': a draft of another kind waits ('불러오기').
    const [banner, setBanner] = useState<null | { mode: 'loaded' } | { mode: 'offer'; draft: Draft }>(null);
    // Bumped when the whole form is replaced, so folds and pickers open again for the new values.
    const [version, setVersion] = useState(0);
    const [pendingKind, setPendingKind] = useState<TradeKind | null>(null);
    const [photoCap, setPhotoCap] = useState(PHOTO_CAP);
    // GET me/usage for the 새 글 allowance line above [등록] (first 3 new posts a day are free).
    const [usage, setUsage] = useState<Usage | null>(null);
    // '사진 용량 12.3MB/100MB' while photos are kept in KV or D1 (WP45); nothing with R2 or for the manager.
    const photoLine = usage?.photos && usage.photos.storage !== 'r2' && usage.photos.limit
        ? `사진 용량 ${(usage.photos.used / 1048576).toFixed(1)}MB/${Math.round(usage.photos.limit / 1048576)}MB` : '';
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    // 같은 매물 (WP44): the author's open posts each picked photo is already in, and the 409 sheet.
    const [usedIn, setUsedIn] = useState<Record<string, UsedIn[]>>({});
    const [dup, setDup] = useState<Dup | null>(null);
    const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState(''), [savedAt, setSavedAt] = useState('');
    const formRef = useRef(form), dirty = useRef(false), done = useRef(false), lastSaved = useRef(''), fileInput = useRef<HTMLInputElement>(null), post = useRef<Post | null>(null);
    formRef.current = form;
    // New posts share one draft slot, so the waiting draft of another kind is not overwritten
    // until the member loads it or closes the banner.
    const holding = useRef(false);
    holding.current = banner?.mode === 'offer';
    const draftKey = id || 'new';
    const unsaved = () => dirty.current && !done.current && JSON.stringify(formRef.current) !== lastSaved.current;
    // This form is not auto-saved while that draft waits, so moving to another page in the app asks
    // first: stay, leave without it, or save it over the waiting draft. Holds the answer's resolver.
    const [leaveAsk, setLeaveAsk] = useState<null | ((leave: boolean) => void)>(null);

    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        void refreshMe().catch(() => {});
        if (proxyBlocked) { openApply({ kind: 'badge', target: 'proxy' }); toast('대리(진행): 대리 인증이 필요합니다. 대리(구함)으로 열었습니다.'); }
    }, []);

    // Puts a whole form on screen without marking it as an edit to save again.
    const replaceForm = (next: Form, saved: boolean) => {
        setForm(next); formRef.current = next;
        dirty.current = false;
        lastSaved.current = saved ? JSON.stringify(next) : '';
        setVersion(v => v + 1);
    };
    // A draft keeps only the 꾸미기 of the member's current grade (the post itself comes read-filtered).
    const rank = me ? styleRank(me.grade, me.role) : 0;
    const fromDraft = ({ savedAt: _s, ...rest }: Draft) => { void _s; const f = normalize(rest); return { ...f, body_style: normalizeMarks(f.body, f.body_style, rank) }; };
    const [styling, setStyling] = useState(false);
    // Photos that came with a restored draft (or the post) are looked up too, so the used-photo line
    // below the grid also shows for them.
    useEffect(() => {
        const ids = formRef.current.images.slice(0, 100);
        if (!version || !ids.length) return;
        let alive = true;
        api<{ usedIn: Record<string, UsedIn[]> }>('uploads/lookup', 'POST', { ids })
            .then(d => { if (alive) setUsedIn(u => ({ ...u, ...d.usedIn })); }).catch(() => {});
        return () => { alive = false; };
    }, [version]);

    useEffect(() => {
        if (!me) return;
        let alive = true;
        Promise.all([
            id ? api<{ post: Post }>('posts/' + id) : Promise.resolve(null),
            api<{ draft: Draft | null }>('drafts/' + draftKey),
            api<Usage>('me/usage').catch(() => null),
        ]).then(([p, dr, usage]) => {
            if (!alive) return;
            if (p && p.post.author_id !== me.id) throw new Error('본인 글만 수정할 수 있습니다.');
            // A completed post is read-only (WP43).
            if (p && p.post.status === 'closed') throw new Error('완료된 글은 수정할 수 없습니다.');
            const base = p ? fromPost(p.post) : initial;
            post.current = p?.post || null;
            // An edit may keep the photos a post already has.
            setPhotoCap(Math.max(usage?.rules.photosPerPost ?? PHOTO_CAP, p?.post.images.length || 0));
            setUsage(usage);
            const draft = dr.draft && typeof dr.draft.kind === 'string' && 'offer' in dr.draft ? dr.draft : null;
            if (!draft) replaceForm(base, false);
            else if (p) {
                // An edit draft counts only when it is newer than the post itself.
                if ((draft.savedAt || 0) > p.post.updated_at) { replaceForm(fromDraft(draft), true); setBanner({ mode: 'loaded' }); }
                else { replaceForm(base, false); api('drafts/' + draftKey, 'DELETE').catch(() => {}); }
            } else if (!urlKind || fromDraft(draft).kind === initial.kind) {
                replaceForm(fromDraft(draft), true); setBanner({ mode: 'loaded' });
            } else {
                // '구매 글쓰기' from the 구매 board keeps 구매; the draft of another kind waits for 불러오기.
                replaceForm(base, false); setBanner({ mode: 'offer', draft });
            }
            setLoaded(true);
        }).catch(e => { if (alive) setLoadError(errorText(e)); });
        return () => { alive = false; };
    }, [id, me?.id]);

    const persist = async (manual = false) => {
        if (!loaded || done.current || (!dirty.current && !manual) || (holding.current && !manual)) return true;
        const snapshot = JSON.stringify(formRef.current);
        if (snapshot === lastSaved.current && !manual) return true;
        try {
            await api('drafts/' + draftKey, 'PUT', JSON.parse(snapshot));
            lastSaved.current = snapshot;
            setSavedAt(kstClock(Date.now()));
            // The waiting draft has just been replaced by this form.
            setBanner(b => b?.mode === 'offer' ? null : b);
            if (manual) toast('임시저장 완료');
            return true;
        } catch (e) { if (manual) toast.error(errorText(e)); return false; }
    };
    // Auto-save shortly after edits, and before leaving the page.
    useEffect(() => { if (!loaded || !dirty.current) return; const t = setTimeout(() => void persist(), 1500); return () => clearTimeout(t); }, [form, loaded, banner]);
    useEffect(() => {
        if (!loaded) return;
        setLeaveGuard(async () => {
            if (holding.current && unsaved()) return new Promise<boolean>(resolve => setLeaveAsk(() => resolve));
            await persist(); return true;
        });
        const warn = (e: BeforeUnloadEvent) => { if (unsaved()) e.preventDefault(); };
        window.addEventListener('beforeunload', warn);
        return () => {
            setLeaveGuard(null);
            window.removeEventListener('beforeunload', warn);
            // Leaving with the browser's Back button skips the guard, so the last edits are sent on the way out.
            if (unsaved() && !holding.current) void fetch('/api/drafts/' + draftKey, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formRef.current) }).catch(() => {});
        };
    }, [loaded]);

    async function answerLeave(choice: 'stay' | 'leave' | 'save') {
        const resolve = leaveAsk;
        if (!resolve) return;
        // A failed save keeps the question open; its error shows as a toast.
        if (choice === 'save' && !(await persist(true))) return;
        setLeaveAsk(null);
        resolve(choice !== 'stay');
    }

    function startOver() {
        replaceForm(post.current ? fromPost(post.current) : initial, false);
        setSavedAt('');
        setBanner(null);
        api('drafts/' + draftKey, 'DELETE').catch(() => {});
    }
    function loadDraft(draft: Draft) {
        replaceForm(fromDraft(draft), true);
        setBanner({ mode: 'loaded' });
    }

    const patch = (v: Partial<Form>) => { dirty.current = true; setForm(f => ({ ...f, ...v })); };
    // Typing moves the 꾸미기 ranges with the text (WP49).
    const patchBody = (body: string) => { dirty.current = true; setForm(f => ({ ...f, body, body_style: shiftOnEdit(f.body, body, f.body_style) })); };
    const setDetail = (key: string, value: string) => patch({ details: { ...formRef.current.details, [key]: value } });

    function changeKind(kind: TradeKind) {
        if (kind === form.kind) return;
        if (kind === 'proxy_offer' && !proxyAllowed) { openApply({ kind: 'badge', target: 'proxy' }); return; }
        if (dropsInput(form, forKind(form, kind))) { setPendingKind(kind); return; }
        applyKind(kind);
    }
    function applyKind(kind: TradeKind) {
        const next = forKind(formRef.current, kind);
        dirty.current = true;
        setForm(next);
        setPendingKind(null);
    }
    function changeCategory(category: string) {
        if (category === form.category) return;
        const keep = form.kind === 'exchange' ? Object.fromEntries(Object.entries(form.details).filter(([k]) => k.startsWith('wanted'))) : {};
        patch({ category, tags: [], ladderHidden: {}, clanTags: [], details: keep });
    }

    // Photos from the picker, a paste or a drop, within the cap; one batch at a time, 3 uploads at
    // once ('사진 올리는 중 12/40'). The photos keep the order they were picked in.
    async function addPhotos(files: File[]) {
        if (!files.length) return;
        if (uploading) { toast.error(UPLOAD_BUSY); return; }
        const list = files.slice(0, Math.max(0, photoCap - form.images.length));
        if (files.length > list.length) toast.error(`사진은 한 글에 ${photoCap}장까지입니다.`);
        if (!list.length) { if (fileInput.current) fileInput.current.value = ''; return; }
        setUploading(true);
        setProgress({ done: 0, total: list.length });
        // The originals' hashes first: photos this member already uploaded are reused without
        // compressing or uploading them again (the hashes are advisory; a browser without them uploads).
        const hashes = await Promise.all(list.map(f => fileHash(f)));
        const known = await lookupPhotos(hashes.filter((h): h is string => !!h));
        const added: (string | null)[] = list.map(() => null);
        const seen: Record<string, UsedIn[]> = { ...known.usedIn };
        let next = 0, failed: unknown = null;
        const worker = async () => {
            while (next < list.length && !failed) {
                const i = next++, h = hashes[i];
                try {
                    if (h && known.found[h]) added[i] = known.found[h];
                    else { const up = await sendPhoto(list[i], h); added[i] = up.id; seen[up.id] = up.usedIn; }
                } catch (e) { failed = failed || e; }
                setProgress(pr => pr && { ...pr, done: pr.done + 1 });
            }
        };
        try { await Promise.all([worker(), worker(), worker()]); }
        finally {
            if (failed) toast.error(errorText(failed));
            // A photo already in the grid (picked again) is not added twice.
            const ids = [...new Set(added.filter((v): v is string => !!v))].filter(v => !formRef.current.images.includes(v));
            if (ids.length) patch({ images: [...formRef.current.images, ...ids] });
            setUsedIn(u => ({ ...u, ...seen }));
            // '사진 용량 12.3MB/100MB' follows the new photos (KV and D1 only).
            if (photoLine) api<Usage>('me/usage').then(setUsage).catch(() => {});
            setUploading(false);
            setProgress(null);
            if (fileInput.current) fileInput.current.value = '';
        }
    }
    // A screenshot pasted anywhere on the page, or a photo dropped on it, goes into 사진 like one picked
    // from the album. Text pastes and drags are left alone, also text that comes with a picture of it
    // (Excel, Word) pasted into a field; a dropped file never replaces the page.
    const addPhotosRef = useRef(addPhotos);
    addPhotosRef.current = addPhotos;
    useEffect(() => {
        if (!loaded) return;
        const paste = (e: ClipboardEvent) => {
            const files = imageFiles(e.clipboardData?.files);
            if (!files.length || pastesText(e.target, e.clipboardData)) return;
            e.preventDefault();
            void addPhotosRef.current(files);
        };
        const over = (e: DragEvent) => { if (e.dataTransfer && dragsFiles(e.dataTransfer.types)) e.preventDefault(); };
        const drop = (e: DragEvent) => {
            if (!e.dataTransfer || !dragsFiles(e.dataTransfer.types)) return;
            e.preventDefault();
            void addPhotosRef.current(imageFiles(e.dataTransfer.files));
        };
        document.addEventListener('paste', paste);
        document.addEventListener('dragover', over);
        document.addEventListener('drop', drop);
        return () => {
            document.removeEventListener('paste', paste);
            document.removeEventListener('dragover', over);
            document.removeEventListener('drop', drop);
        };
    }, [loaded]);

    const priceWon = form.kind === 'sell' ? manToWon(form.price) : null, offerWon = form.kind === 'sell' ? manToWon(form.offer) : null;
    const offerTooHigh = priceWon !== null && offerWon !== null && !Number.isNaN(priceWon) && !Number.isNaN(offerWon) && offerWon >= priceWon;

    // A refusal shows as a toast too: the alert sits at the end of the form, under the sticky 등록 bar.
    const showError = (text: string) => { setError(text); toast.error(text); };
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || uploading) return;
        setError('');
        const price = form.kind === 'exchange' ? null : manToWon(form.price);
        const offer = form.kind === 'sell' ? manToWon(form.offer) : null;
        if (Number.isNaN(price) || Number.isNaN(offer)) { showError('가격은 만원 단위 숫자로 입력해 주세요. 예: 35, 1.5'); return; }
        // The rule shows under 현젯; nothing is sent until it is fixed.
        if (offerTooHigh) { document.getElementById('ed-offer')?.focus(); return; }
        if (form.kind === 'proxy_offer' && !proxyAllowed) { openApply({ kind: 'badge', target: 'proxy' }); return; }
        setBusy(true);
        try {
            const details = { ...form.details, ...(offer !== null ? { currentOffer: String(offer) } : {}) };
            // The list thumbnail of the 대표 photo (WP45), made again whenever images[0] changed (WP46) or the
            // post has none. Without one (no WebP in this browser) the list shows the photo itself, and an
            // edit keeps the thumbnail it had while the 대표 is the same.
            const cover = form.images[0], had = post.current;
            const thumb = cover && (!had || had.images[0] !== cover || !had.thumb) ? await makeThumb(cover) : null;
            const payload = { kind: form.kind, category: form.category, title: form.title, body: form.body, price, accepts_offers: form.kind === 'sell' && (price === null || form.accepts_offers), tags: form.tags, wantedTags: form.kind === 'exchange' ? form.wantedTags : [], ladderHidden: holdsHidden(form) ? form.ladderHidden : {},
                clanTags: form.category === 'clan' ? form.clanTags : [], wantedClanTags: form.kind === 'exchange' && form.details.wantedCategory === 'clan' ? form.wantedClanTags : [], details, images: form.images, link_preview: form.link_preview, body_style: encodeStyle(form.body, normalizeMarks(form.body, form.body_style, rank)) ?? '', ...thumb ? { thumb } : {} };
            done.current = true;
            const d = await api<{ id: number; placed?: 'fresh' | 'bump' | 'last' | 'old'; bumpAt?: number; notice?: string }>(id ? 'posts/' + id : 'posts', id ? 'PUT' : 'POST', payload);
            if (!holding.current) api('drafts/' + draftKey, 'DELETE').catch(() => {});
            setLeaveGuard(null);
            toast(id ? d.notice || '수정 완료'
                : d.placed === 'bump' ? '등록 완료 · 끌올 1개 사용'
                : d.placed === 'old' ? `같은 매물이라 이전 자리에 등록했습니다.${d.bumpAt && d.bumpAt > Date.now() ? ` (${readyClock(d.bumpAt)}부터 끌올 가능)` : ''}`
                : d.placed === 'last' ? '끌올이 없어 최근 끌올 글 아래에 등록했습니다.' : '등록 완료');
            void navigate('/posts/' + d.id, { replace: !!id, force: true });
        } catch (err) {
            done.current = false;
            // The same listing is open: the sheet names it and offers its 끌올; the draft stays.
            if (err instanceof ApiError && err.status === 409 && err.data?.dup) setDup(err.data.dup);
            else showError(errorText(err));
        }
        finally { setBusy(false); }
    }

    // From the 4th new post of the KST day, a new post spends 1 끌올 (or, with none left, goes to the
    // latest 끌올 place). Nothing for the manager (no wallet).
    const wallet = usage ? walletNow(usage, Date.now()) : null, freshPerDay = usage?.rules.freshPerDay ?? 3;
    const freshLine = usage && wallet && (usage.freshToday ?? 0) >= freshPerDay
        ? `오늘 새 글 ${freshPerDay}개 사용 · ${wallet.tokens >= 1 ? '이번 글은 끌올 1개' : '남은 끌올 없음'}` : '';
    // The picked photos are mostly one open post's (2 × shared > the larger set): one line under the
    // grid names it and offers its 끌올 instead of a second post.
    const photoPost = (() => {
        const counts = new Map<number, { post: UsedIn; n: number }>();
        for (const img of form.images) for (const p of usedIn[img] || []) {
            if (p.id === Number(id)) continue;
            const c = counts.get(p.id) || { post: p, n: 0 };
            c.n++;
            counts.set(p.id, c);
        }
        return [...counts.values()].find(c => 2 * c.n > Math.max(form.images.length, c.post.photos))?.post || null;
    })();
    async function bumpUsed(postId: number) {
        try {
            const d = await api<{ nextBumpAt?: number }>(`posts/${postId}/bump`, 'POST');
            toast('끌올 완료');
            // The line then shows when that post can be bumped again.
            const next = d.nextBumpAt ?? null;
            setUsedIn(u => Object.fromEntries(Object.entries(u).map(([k, list]) => [k, list.map(p => p.id === postId ? { ...p, bumpAt: next } : p)])));
        }
        catch (e) { toast.error(errorText(e)); }
    }
    // While that post cannot be bumped yet (its gap, its 새 글 우선 hour or an empty wallet) the line
    // says from when instead of offering a 끌올 that would only fail.
    const usedWait = photoPost?.bumpAt && photoPost.bumpAt > Date.now() ? photoPost.bumpAt : 0;
    if (!me) return <div className="container page"><EmptyState icon="lock" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    if (loadError) return <div className="container page"><EmptyState title="글을 불러오지 못했습니다" text={loadError} /></div>;
    if (!loaded) return <div className="container page"><SkeletonRows count={3} height={180} /></div>;

    const { kind, category, details: d } = form;
    const account = category === 'account', buying = kind === 'buy', wanted = d.wantedCategory === 'clan' ? 'clan' : 'account';
    // Under 이용 정지 the server refuses 등록 and 수정, so the editor says so before any typing; 임시저장 still works.
    const suspendedUntil = me.suspended_until && me.suspended_until > Date.now() ? me.suspended_until : null;
    const ranksOf = (key: string) => parseList(d[key], NICK_RANKS);
    // 닉 종류: nicknameTypes on 판매 and the offered side of 교환, wantedNicknameTypes on 구매 and the wanted side.
    const nickTypes = (key: 'nicknameTypes' | 'wantedNicknameTypes') => <div className="field"><span className="field-label">닉 종류</span>
        <NickTypePicker multiple value={parseList(d[key], NICK_TYPES)} onChange={v => setDetail(key, v.length ? JSON.stringify(v) : '')} />
        <span className="field-hint">{RARE_NICK_HINT}</span>
    </div>;
    const hasWanted = form.wantedTags.length > 0 || form.wantedClanTags.length > 0 || Object.entries(d).some(([k, v]) => k.startsWith('wanted') && k !== 'wantedCategory' && !!v);
    // 특징 태그 (WP70) on 판매 and the offered side of 교환: '#불새상류', up to 10.
    const tagField = (label: string) => <div className="field"><span className="field-label">{label}</span>
        <TagInput label={label} value={featureTags(d.featureTags)} onChange={v => setDetail('featureTags', v.length ? JSON.stringify(v) : '')} /></div>;

    const sellerAccount = <div className="grid-gap-16">
        <div className="field"><span className="field-label">래더 기록</span><SeasonPicker value={form.tags} onChange={tags => patch({ tags })} hidden={form.ladderHidden} onHiddenChange={ladderHidden => patch({ ladderHidden })} /></div>
        <div className="ed-grid">
            <Num label="대주 수" value={d.ownerCount || ''} onChange={v => setDetail('ownerCount', v)} unit="대주" max={9999} placeholder="예: 2" />
            <div className="field"><span className="field-label">전적</span><Segmented name="전적" options={['무전적', '전적 있음'] as const} value={d.recordStatus || ''} onChange={v => setDetail('recordStatus', v)} /></div>
            <Num label="닉네임 글자 수" value={d.nicknameChars || ''} onChange={v => setDetail('nicknameChars', v)} unit="글자" max={20} placeholder="예: 2" />
            <div className="field"><span className="field-label">닉 등급</span><RankPicker value={d.nicknameRank ? [d.nicknameRank] : []} onChange={v => setDetail('nicknameRank', v[0] || '')} /></div>
        </div>
        {nickTypes('nicknameTypes')}
        <div className="field"><span className="field-label">우대 스킨</span><SkinPicker value={skinTags(d.skinTags)} onChange={v => setDetail('skinTags', v.length ? JSON.stringify(v) : '')} /><span className="field-hint">없는 스킨은 내용에 적어 주세요.</span></div>
        {tagField('계정 특징 태그')}
        <div className="ed-grid ed-grid-3">
            <Num label={PHANTOM_LABEL} value={d.phantom || ''} onChange={v => setDetail('phantom', v)} unit="%" max={PHANTOM_MAX} placeholder="예: 225" hint={PHANTOM_HINT} />
            <Num label="가스" value={d.gas || ''} onChange={v => setDetail('gas', v)} placeholder="예: 246" />
            <Num label="미네랄" value={d.minerals || ''} onChange={v => setDetail('minerals', v)} placeholder="예: 1400000" />
        </div>
        <Fold filled={ACCOUNT_MORE_KEYS.some(k => d[k])} summary={<>추가 정보 <span>통합, 전비변, 보멜, 레벨, 연구실, 옷장</span></>}>
            <div className="ed-grid mt-16">
                {(['integrated', 'passwordChange', 'phoneChange', 'backupEmail'] as const).map(k => <div className="field" key={k}><span className="field-label">{ACCOUNT_CHOICES[k].label}</span><Segmented name={ACCOUNT_CHOICES[k].label} options={ACCOUNT_CHOICES[k].options} label={v => choiceLabel(k, v)} value={d[k] || ''} onChange={v => setDetail(k, v)} /></div>)}
                <Num label="레벨" value={d.level || ''} onChange={v => setDetail('level', v)} max={999} />
                <Num label="연구실" value={d.labLevel || ''} onChange={v => setDetail('labLevel', v)} max={99} />
                <Num label="인간 스킨 수" value={d.humanSkins || ''} onChange={v => setDetail('humanSkins', v)} unit="개" />
                <Num label="좀비 스킨 수" value={d.zombieSkins || ''} onChange={v => setDetail('zombieSkins', v)} unit="개" />
                <Num label="옷장" value={d.closet || ''} onChange={v => setDetail('closet', v)} unit="칸" max={999} />
            </div>
        </Fold>
    </div>;

    const buyerAccount = (prefix: '' | 'wanted') => {
        const k = (name: string) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
        return <div className="grid-gap-16">
            <div className="ed-grid">
                <Num label="대주 수" value={d[k('maxOwners')] || ''} onChange={v => setDetail(k('maxOwners'), v)} unit="대주 이하" max={9999} placeholder="상관없음" />
                <Num label={PHANTOM_LABEL} value={d[k('phantomMin')] || ''} onChange={v => setDetail(k('phantomMin'), v)} unit="% 이상" max={PHANTOM_MAX} placeholder="예: 225" hint={PHANTOM_HINT} />
            </div>
            <div className="field"><span className="field-label">전적</span><Segmented name={prefix + '전적'} options={RECORD_PREFERENCES} value={d[k('recordPreference')] || ''} onChange={v => setDetail(k('recordPreference'), v)} /></div>
            <div className="field"><span className="field-label">원하는 닉네임</span>
                <div className="range nick-range">
                    <div className="input-unit"><IntegerInput className="input" placeholder="최소" aria-label="닉네임 최소 글자 수" value={d[k('nicknameCharsMin')] || ''} max={20} onChange={v => setDetail(k('nicknameCharsMin'), v)} /><span>글자</span></div>
                    <span>~</span>
                    <div className="input-unit"><IntegerInput className="input" placeholder="최대" aria-label="닉네임 최대 글자 수" value={d[k('nicknameCharsMax')] || ''} max={20} onChange={v => setDetail(k('nicknameCharsMax'), v)} /><span>글자</span></div>
                </div>
                <RankPicker multiple value={ranksOf(k('nicknameRanks'))} onChange={v => setDetail(k('nicknameRanks'), v.length ? JSON.stringify(v) : '')} />
                <span className="field-hint">등급 중복 선택 가능</span>
            </div>
            {nickTypes('wantedNicknameTypes')}
            <div className="field"><span className="field-label">원하는 래더</span>
                {prefix ? <SeasonPicker value={form.wantedTags} onChange={wantedTags => patch({ wantedTags })} /> : <SeasonPicker value={form.tags} onChange={tags => patch({ tags })} />}
            </div>
            <div className="field"><span className="field-label">우대 스킨</span><SkinPicker value={skinTags(d[k('skinTags')])} onChange={v => setDetail(k('skinTags'), v.length ? JSON.stringify(v) : '')} /></div>
        </div>;
    };

    const field = (f: DetailField) => f.type === 'number'
        ? <Num key={f.id} label={f.label} value={d[f.id] || ''} onChange={v => setDetail(f.id, v)} />
        : <label className="field" key={f.id}><span className="field-label">{f.label}</span><input className="input" type={f.type === 'date' ? 'date' : 'text'} maxLength={500} placeholder={f.placeholder || ''} value={d[f.id] || ''} onChange={e => setDetail(f.id, e.target.value)} /></label>;
    const generic = (cat: string) => {
        const fields = (DETAIL_FIELDS[cat] || []).filter(f => !(kind === 'proxy_offer' && f.id === 'current'));
        // 대리: only 가격 기준 stays out; 종목, 현재, 목표, 가능 시간, 기간, 조건 fold into 추가 정보.
        const proxy = isProxyKind(kind);
        const main = proxy ? fields.filter(f => !PROXY_MORE_KEYS.includes(f.id)) : fields;
        const more = proxy ? fields.filter(f => PROXY_MORE_KEYS.includes(f.id)) : [];
        return <div className="grid-gap-16">
            {cat === 'ladder' && <div className="field"><span className="field-label">{kind === 'proxy_offer' ? '내 래더 기록' : kind === 'proxy_request' ? '계정 래더 기록' : '래더 시즌'}</span><SeasonPicker value={form.tags} onChange={tags => patch({ tags })} /></div>}
            {main.length > 0 && <div className="ed-grid">{main.map(field)}</div>}
            {more.length > 0 && <Fold filled={more.some(f => d[f.id])} summary={<>추가 정보 <span>{more.map(f => f.label).join(', ')}</span></>}>
                <div className="ed-grid mt-16">{more.map(field)}</div>
            </Fold>}
        </div>;
    };

    // 클랜 (WP70): the clan's fields, 현재 클랜 티어 and its 클랜 래더 (구매: the clan tiers wanted), and on 판매 and the
    // offered side of 교환 its 특징 태그. A 교환 that asks for a clan names the wanted tier and clan ladder.
    const clanInfo = <div className="grid-gap-16">
        {generic('clan')}
        <div className="field"><span className="field-label">현재 클랜 티어</span><ClanTierPicker value={d.clanTier || ''} onChange={v => setDetail('clanTier', v)} /></div>
        <div className="field"><span className="field-label">{buying ? '원하는 클랜 티어' : '클랜 래더 기록'}</span><SeasonPicker clan value={form.clanTags} onChange={clanTags => patch({ clanTags })} /></div>
        {!buying && tagField('클랜 특징 태그')}
    </div>;
    const wantedClan = <div className="grid-gap-16">
        <div className="field"><span className="field-label">현재 클랜 티어</span><ClanTierPicker value={d.wantedClanTier || ''} onChange={v => setDetail('wantedClanTier', v)} /></div>
        <div className="field"><span className="field-label">원하는 클랜 티어</span><SeasonPicker clan value={form.wantedClanTags} onChange={wantedClanTags => patch({ wantedClanTags })} /></div>
    </div>;

    const infoTitle = account ? (buying ? '원하는 계정' : '계정 정보') : category === 'clan' && buying ? '원하는 클랜' : kind === 'proxy_request' ? '요청 내용' : kind === 'proxy_offer' ? '진행 내용' : `${categoryName(category)} 정보`;
    const hasInfo = account || (DETAIL_FIELDS[category]?.length || 0) > 0;
    const photoCount = `${form.images.length}/${photoCap}`;
    // 링크 미리보기 (WP48): the switch shows for 플러스 and up (the 무료 체험 too) once the body holds a link.
    const previewAllowed = !!me && linkPreviewAllowed(me.grade, me.role), hasLink = previewAllowed && findLinks(form.body).length > 0;

    return <div className="container page editor">
        <div className="ed-top">
            <h1 className="page-title">{id ? '글 수정' : '글쓰기'}</h1>
            <span className="muted small">{savedAt ? `${savedAt} 자동 저장됨` : ''}</span>
        </div>
        {suspendedUntil && <p className="alert" role="status">이용 정지 중입니다. ({suspendUntilText(suspendedUntil)})</p>}
        {banner && <div className="restore" role="status">
            <span>{banner.mode === 'loaded' ? '임시저장된 글을 불러왔습니다' : '임시저장된 글이 있습니다'}</span>
            <span aria-hidden="true">·</span>
            {banner.mode === 'loaded'
                ? <button type="button" className="restore-action" onClick={startOver}>새로 쓰기</button>
                : <button type="button" className="restore-action" onClick={() => loadDraft(banner.draft)}>불러오기</button>}
            {banner.mode === 'offer' && <button type="button" className="icon-btn restore-close" aria-label="닫기" onClick={() => setBanner(null)}><X size={16} /></button>}
        </div>}
        <form className="ed-form" onSubmit={submit} key={version}>
            <fieldset disabled={busy}>
                <Section title="게시판">
                    <div className="kind-cards" role="radiogroup" aria-label="거래 구분">
                        {TRADE_KINDS.map(k => {
                            const locked = k === 'proxy_offer' && !proxyAllowed;
                            return <label key={k} className={'kind-card' + (locked ? ' is-locked' : '')}>
                                <input type="radio" name="kind" checked={kind === k} onChange={() => changeKind(k)} onClick={() => { if (locked) changeKind(k); }} />
                                <CIcon name={KIND_ICONS[k]} size={36} /><span>{KIND_NAMES[k]}</span>
                                {locked && <small><Lock size={11} /><span>대리 인증 필요</span></small>}
                            </label>;
                        })}
                    </div>
                    {kind === 'exchange' ? <div className="exchange-pick mt-16">
                        <Segmented name="내놓는 대상" options={EXCHANGE_SIDES} label={categoryName} allowEmpty={false} value={category} onChange={v => { if (v) changeCategory(v); }} />
                        <span>에서</span>
                        <Segmented name="구하는 대상" options={EXCHANGE_SIDES} label={categoryName} allowEmpty={false} value={wanted}
                            onChange={v => { if (v && v !== wanted) patch({ details: { ...Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('wanted'))), wantedCategory: v }, wantedTags: [], wantedClanTags: [] }); }} />
                        <span>구함</span>
                    </div> : <div className="chip-row mt-16" role="radiogroup" aria-label="세부 분류">
                        {categoriesForKind(kind).map(c => <button type="button" key={c.id} role="radio" aria-checked={category === c.id} className="chip" aria-pressed={category === c.id} onClick={() => changeCategory(c.id)}>{c.name}</button>)}
                    </div>}
                </Section>

                <section className="ed-section">
                    <label className="field"><span className="field-label">제목 <em>*</em></span>
                        <input className="input" required minLength={2} maxLength={100} value={form.title} onChange={e => patch({ title: e.target.value })} placeholder={titlePlaceholder(kind, category, wanted)} /></label>
                </section>

                {kind !== 'exchange' && <Section title="가격" desc="단위: 만원 (1.5 = 15,000원)">
                    {kind === 'sell' ? <div className="grid-gap-16">
                        <div className="ed-grid">
                            <Num decimal label="즉거가" value={form.price} onChange={v => patch({ price: v })} unit="만원" placeholder="미정" />
                            <Num decimal id="ed-offer" label="현젯 (현재 제시가)" value={form.offer} onChange={v => patch({ offer: v })} unit="만원" placeholder="없음"
                                error={offerTooHigh ? '현젯은 즉거가보다 낮게 입력해 주세요.' : ''} />
                        </div>
                        {/* 비슷한 거래완료 글 (WP51): the 판매 board in a new tab, same category and 래더 기록, completed posts only. */}
                        <a className="ed-similar" href={similarHref(category, form.tags)} target="_blank" rel="noreferrer">비슷한 거래완료 글</a>
                        {id && <p className="field-hint">이전 즉거가는 취소선으로 남습니다.</p>}
                        <label className="switch"><input type="checkbox" checked={form.price === '' || form.accepts_offers} disabled={form.price === ''} onChange={e => patch({ accepts_offers: e.target.checked })} />제시 받기</label>
                    </div> : <div className="ed-grid">
                        <Num decimal label={buying ? '최대 사용 가능 금액 (MAX)' : kind === 'proxy_request' ? '희망 가격' : '가격'} value={form.price} onChange={v => patch({ price: v })} unit="만원" placeholder={buying ? '미정' : '협의'} />
                    </div>}
                </Section>}

                {kind === 'exchange' ? <>
                    <Section title={`내가 내놓는 ${categoryName(category)}`}>{account ? sellerAccount : clanInfo}</Section>
                    <section className="ed-section">
                        <Fold className="ed-fold" filled={hasWanted} summary={<h2>{`내가 구하는 ${categoryName(wanted)}`}</h2>}>
                            <div className="mt-16">{wanted === 'account' ? buyerAccount('wanted') : wantedClan}</div>
                        </Fold>
                    </section>
                </> : hasInfo && <Section title={infoTitle}>
                    {account ? (buying ? buyerAccount('') : sellerAccount) : category === 'clan' ? clanInfo : generic(category)}
                </Section>}

                <section className="ed-section">
                    <div className="field">
                        <div className="row"><label className="field-label grow" htmlFor="body">내용 <em>*</em></label>
                            <button type="button" className="btn btn-text small" disabled={!!form.body.trim()} onClick={() => patchBody(template(kind, category))}>양식 불러오기</button></div>
                        <textarea id="body" className="textarea" required maxLength={10000} value={form.body} onChange={e => patchBody(e.target.value)}
                            placeholder={bodyPlaceholder(kind, category)} />
                        <div className="row"><span className="field-hint grow">비번, 인증번호는 쓰지 마세요.</span><span className="field-hint nowrap">{form.body.length.toLocaleString()} / 10,000</span>
                            <button type="button" className="btn btn-line btn-sm ed-style-btn" disabled={!form.body.trim()} onClick={() => setStyling(true)}>{form.body_style.length ? `꾸미기 ${form.body_style.length}` : '꾸미기'}</button></div>
                        {styling && <Suspense fallback={null}><StyleSheet body={form.body} marks={form.body_style} rank={rank} onClose={() => setStyling(false)}
                            onChange={m => { dirty.current = true; setForm(f => ({ ...f, body_style: m })); }} /></Suspense>}
                        {previewAllowed && hasLink && <label className="switch mt-8"><input type="checkbox" checked={form.link_preview} onChange={e => patch({ link_preview: e.target.checked })} />링크 미리보기</label>}
                    </div>
                </section>

                <section className="ed-section">
                    <div className="ed-head ed-head-row"><h2>사진</h2><span className="ed-photo-count">{photoCount}</span></div>
                    <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e => void addPhotos(Array.from(e.target.files || []))} />
                    <PhotoGrid images={form.images} onChange={images => patch({ images })} canAdd={form.images.length < photoCap} uploading={uploading} onAdd={() => fileInput.current?.click()} />
                    {form.images.length > 0 && <p className="field-hint mt-8">대표 사진이 목록에 표시</p>}
                    {progress && <p className="field-hint mt-8" role="status">사진 올리는 중 {progress.done}/{progress.total}</p>}
                    {photoLine && !progress && <p className="field-hint mt-8 ed-photo-usage">{photoLine}</p>}
                    {photoPost && <p className="field-hint mt-8 ed-used">‘{photoPost.title}’ 글에 있는 사진입니다. {usedWait ? <span className="nowrap">{readyClock(usedWait)}부터 끌올 가능</span> : <button type="button" className="ed-used-bump" onClick={() => void bumpUsed(photoPost.id)}>끌올</button>}</p>}
                </section>

                {error && <p className="alert alert-danger" role="alert">{error}</p>}
                {!id && freshLine && <p className="field-hint ed-fresh">{freshLine}</p>}
                <div className="ed-bar">
                    <button type="button" className="btn btn-line" onClick={() => void persist(true)}>임시저장</button>
                    <button type="submit" className="btn btn-primary grow" disabled={busy || uploading || !!suspendedUntil}>{busy ? <LoaderCircle size={18} className="spin" /> : id ? '수정' : '등록'}</button>
                </div>
            </fieldset>
        </form>
        <SameListingSheet dup={dup} onClose={() => setDup(null)} />
        <Modal open={!!pendingKind} onClose={() => setPendingKind(null)} title="거래 구분 변경" description="거래 구분을 바꾸면 입력한 계정 정보가 지워집니다."
            footer={<><button type="button" className="btn btn-line" onClick={() => setPendingKind(null)}>취소</button><button type="button" className="btn btn-danger-solid" onClick={() => { if (pendingKind) applyKind(pendingKind); }}>바꾸기</button></>} />
        <Modal open={!!leaveAsk} onClose={() => void answerLeave('stay')} title="저장되지 않은 글" description="이 글을 임시저장하면 이전에 임시저장된 글은 지워집니다."
            footer={<><button type="button" className="btn btn-line" onClick={() => void answerLeave('stay')}>취소</button><button type="button" className="btn btn-danger" onClick={() => void answerLeave('leave')}>나가기</button><button type="button" className="btn btn-primary" onClick={() => void answerLeave('save')}>임시저장</button></>} />
    </div>;
}
