// Copy lint: fails on wording the style guide forbids. It scans every line of
// source text after comments are removed, so JSX text such as <p>…</p> is
// checked as well as quoted strings. A line after a comment containing
// `copy-lint-ignore-next-line` is skipped (user-voice arrays such as quick replies).
// No dependencies: node tests/copy-lint.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const MARKER = 'copy-lint-ignore-next-line';
// 해요체 endings ('있어요' also covers '할 수(도) 있어요'), 제안 in any form (the word is 제시),
// '(선택)' labels and '비워 두세요' hints, question titles and 해요체 questions ('있나요?', '아닌가요?'),
// and words the cafes never use (쪽지, 보조 메일). The home hero '어떤 거래를 찾으세요?' matches none of them.
const BANNED = [
    '있어요', '없어요', '해요', '해 보세요', '준비 중', '돼요', '이에요', '예요',
    '제안', '(선택)', '비워 두세요', '할까요?', '나요?', '가요?', '쪽지', '보조 메일', '반갑습니다', '환영합니다',
    '한눈에', '손쉽게', '편리하게', '간편하게', '혜택을 누려',
    '→', '—', '인증·등급',
    // 중개·가측: the site never takes, holds or moves money, so no wording may promise it; the 수익 홍보 (WP66)
    // shows examples ('사례'), never a promise.
    '대금 보관', '안전 결제', '100% 보장', '사기 0건', '수익 보장', '최소 보장',
    // 등급 혜택 (WP61 owner request 2026-10-01): strong but true; no promise of a sale, speed, price or scarcity
    // and no unproven popularity ('N배 빨리 팔' is the pattern below).
    '판매 보장', '빨리 팔림', '100%', '사기 0', '최저가 보장', '한정', '마감 임박', '인기 1위',
];
// Patterns the guide forbids as well: '3배 빨리 팔려요', '10배 빨리 팔림'.
const BANNED_PATTERNS = [/\d+(?:\.\d+)?\s*배\s*빨리\s*팔/];

// Retired wording (WP40 끌올 지갑): the daily 끌올 count and its midnight reset are gone. WP43 retires
// 예약중 everywhere (two states), with the accept line that named it and the old 마감 line.
// 광고 (WP53) replaces the round-2 '프리미엄 매물' box and its 게시판 상단 노출 switch.
const RETIRED = ['자정에 초기화', '오늘 끌올', '거래중·예약중 글은', '예약중', '글 상태가 바뀌어 제시가 마감되었습니다.', '예약 걸어둘게요',
    '프리미엄 매물', '상단 고정', '상단 노출 빼기', '게시판 상단 노출',
    // 프로필 배너 was dropped (WP63, decisions item 7).
    '프로필 배너는 프리미엄부터 가능합니다.', '배너 변경'];
// Wallet wording that must stay in the source (copy.md, style guide §6). Each entry is a literal
// fragment; templated strings are split at their variables.
const REQUIRED = [
    '끌올이 없습니다. ', '에 1개 충전됩니다.',
    '같은 글은 ', '마다 끌올할 수 있습니다. (', '부터 가능)',
    '새 글 우선 중인 글은 ', '부터 끌올할 수 있습니다.',
    '후 충전', '끌올 완료', '끌올이 ', '개로 충전되었습니다.',
    '도배 방지: 거래중 글은 ', '개까지입니다. 거래완료로 바꾸거나 삭제해 주세요.', '도배 방지: 오늘 새 글은 ',
    '사진은 한 글에 ', '사진 올리는 중 ', '끌올 보관', '끌올 충전', '같은 글 끌올 간격', '일반 (무료)',
    // The 새 글 allowance (decisions item 1b): the 4th new post of the day spends 1 끌올.
    '등록 완료 · 끌올 1개 사용', '끌올이 없어 최근 끌올 글 아래에 등록했습니다.', '개 사용 · ', '이번 글은 끌올 1개', '남은 끌올 없음',
    '개까지 새 글로 올라가고, 그 뒤로는 끌올 1개씩 씁니다.',
    // Two states (WP43): each kind's labels, and 거래중/거래완료 on screens that mix kinds.
    "'판매중'", "'판매완료'", "'구매중'", "'구매완료'", "'구하는중'", "'구함완료'", "'교환중'", "'교환완료'", "'받는중'", "'마감'", "'거래중'", "'거래완료'",
    '완료하면 되돌릴 수 없습니다.', '상대가 확인하면 두 회원의 거래 기록에 남습니다.', '사이트 밖 거래 · 기록 없음', '거래 기록 요청은 한 글에 3번까지입니다.',
    '확인하면 두 회원의 거래 기록에 남습니다. 받을 것을 모두 받은 뒤 확인해 주세요.', '글이 완료되어 제시가 마감되었습니다.', '회원 탈퇴로 제시가 마감되었습니다.',
    // 자동 끌올 (WP52, copy.md).
    '자동 끌올은 플러스부터 가능합니다.', '자동 끌올 글 변경 완료', '자동 끌올이 켜졌습니다. 설정은 내 거래의 자동화 탭에 있습니다.', '자동 끌올 쉬는 중 · 모든 글이 1페이지에 있습니다',
    '답장하지 않은 채팅이 있어 자동 끌올을 멈췄습니다. 답장하면 다시 시작됩니다.', '7일 동안 변경이 없어 자동 끌올을 멈췄습니다.', '체험 중 자동 끌올은 유료 등급 다음 순서입니다.',
    '자동 끌올은 한 번에 글 1개씩 · 2개는 직접 끌올용으로 남김', '자동 끌올은 게시판 활동량에 맞춰 제한됩니다.', '설정은 그대로 남고, 플러스를 신청하면 바로 다시 켜집니다.',
    // 광고 (WP53, copy.md).
    "'광고'", "'광고 매물'", "'엘리트 매물'", "'비슷한 매물'", "'광고 고정'", "'광고 빼기'", '광고 유입 ', '광고는 프리미엄부터 가능합니다.', '광고는 본인 인증 필요',
    "'광고 제외'", '본인 인증 없음 · 광고 제외', '정렬은 등급과 관계없습니다.', '광고는 목록 순서를 바꾸지 않습니다.', '이 회원 글 ', '게시판 상단 ', '거래완료 글 하단',
    // 자동 가격 내리기 (WP56, copy.md and round-3 WP31).
    '문의나 제시가 오면 내리지 않고 기다립니다.', '가격 내리기는 플러스부터 가능합니다.', '즉거가가 있는 판매 글만 가격 내리기를 할 수 있습니다.',
    '최저가는 즉거가보다 낮게 입력해 주세요.', '내림 주기를 확인해 주세요.', '내림 폭을 확인해 주세요.', '글이 최저가에 닿아 가격 내리기를 마쳤습니다.',
    '글 현젯이 다음 가격 이상이라 가격 내리기를 멈췄습니다.', '제시 자동 거절 · ', '최저가 미만 제시 자동 거절', '판매 글 전체', '다음 내림 ',
    // 채팅 자동화 (WP57, copy.md).
    "'자동 응답'", "'첫 문의 자동 안내'", "'자리 비움'", "'지금 자리 비움'", '내 빠른 답장은 플러스부터 가능합니다.', '빠른 답장은 ', '개까지입니다.',
    '첫 문의 자동 안내는 프리미엄부터 가능합니다.', '자리 비움 응답은 엘리트부터 가능합니다.',
    // 중개/가측 (WP66, copy in the package).
    "'중개/가측'", '중개·가측 인증은 플러스 이상 등급부터 신청할 수 있습니다. (무료 체험 제외)', '거래 대금은 사이트를 거치지 않습니다. 인증 표시와 후기를 보고 진행하세요.',
    '아직 등록된 중개인이 없습니다.', '아직 등록된 가측인이 없습니다.', '소개에는 링크와 연락처를 넣을 수 없습니다.', '플러스 이상 등급일 때 목록에 보입니다',
    '중개·가측으로 수익 올리기', '플러스부터 중개·가측 인증 신청 가능', '등급이 높을수록 더 크게, 더 위에 노출 (엘리트는 골드 카드 + 광고 팝업)',
    '운영진이 직접 들은 사례이며, 수익은 활동량에 따라 다릅니다.', '가측만으로 매달 10만원씩 버는 회원도 있습니다', ' 회원이 되었습니다',
    // 등급 혜택 표시 (WP61).
    '일반 대비', '모든 혜택', '월 환산 ', '카페보다 편한 점', '추천 설정 모두 켜기', '추천 설정은 엘리트부터 가능합니다.', '끌올 버튼 (링크 다시 올리기 없음)',
    // 내 글 일괄 변경, 다시 올리기, 맞는 글 and 자동 매칭 (WP58, copy.md and round-3 copy.md 매칭).
    '개를 거래완료로 바꿉니다. 되돌릴 수 없습니다.', '개를 삭제합니다. 복구할 수 없습니다.', '끌올 완료 · ', '개까지 선택할 수 있습니다.', "'모두 끌올'",
    '다시 올리기', '복사해서 새 글', "'맞는 구매 글'", "'맞는 판매 글'", "'자동 매칭'", "'채팅 보내기'", '구매 글 보고 연락드립니다.', '맞는 글 채팅은 하루 ',
    // 신고 처리 순서 (WP60, copy.md 신고).
    "'신고 처리 순서'", "'처리 완료'", "'기각'", "'되돌리기'", '`대기 ${n}`', ' 대기`', '`신고 30일 ${n} · 기각 ${dismissed}`',
    '사기·먹튀, 회수·해킹 계정 신고는 등급과 관계없이 먼저 확인합니다.', '기각된 신고가 30일에 ', '건 이상이면 신고 우선 순위가 적용되지 않습니다.',
    // 판매 통계, 대표 글, 인기순 and the 엘리트 주간 요약 (WP63, round-3 WP38 copy).
    '판매 통계는 프리미엄부터 가능합니다.', "'통계'", "'끌올 효과'", '`확인 거래 기준 · ${n}건 · 중간값 ${price}`', '`지난주 조회 ${views} · 채팅 ${chats} · 끌올 ${bumps}`',
    "'대표 글 고정'", "'대표 글 해제'", '대표 글은 플러스부터 가능합니다.', '`대표 글은 ${n}개까지입니다.`', '>인기순<',
    // 래더 표시 (WP68): one pill per tier ('모든 시즌 챔피언', '챌린저 23~32, 20, 18시즌'), 시즌 비공개 on the seller side.
    '모든 시즌 ', '시즌 비공개 ', ' 시즌 비공개', '전체 선택', '전체 해제', '선택한 래더', ' 외 ',
    '시즌 비공개: 티어와 개수(1~99개)를 확인해 주세요.', '시즌 비공개는 판매·교환 계정 글에만 넣을 수 있습니다.',
    // 클랜 래더 티어, 레어닉, 특징 태그, 검색·필터 (WP70).
    "'레어닉'", '레어닉: 누구나 아는 단어나 게임 속 이름 (예: 사과, 철수, 엠제이)', "'클랜 래더 기록'", "'원하는 클랜 티어'", '현재 클랜 티어', '클랜 순위 ',
    "'1위'", "'2~3위'", "'4~10위'", "'11~25위'", "'26~45위'", "'46~70위'", "'71~100위'", '클랜 래더 첫 시즌', '고정 태그',
    '계정 특징 태그', '클랜 특징 태그', '특징 태그: 띄어쓰기 없이 1~12자로 입력해 주세요.', '특징 태그는 10개까지입니다.', '특징 태그는 판매·교환 계정·클랜 글에만 넣을 수 있습니다.',
    '띄어쓰기 없이 12자까지', '클랜 래더: 티어와 시즌을 확인해 주세요.', '현재 클랜 티어를 확인해 주세요.', '태그 검색 조건을 확인해 주세요.',
    '무전적 (초기화 포함)', '레벨 · 스킨 · 재화', '클랜 레벨 · 클랜원', '태그 입력 (예: 불새상류)', '스킨, 제목, 닉네임, 태그 (예: 악주, 불새상류)',
];

async function files(dir, recursive, test) {
    const full = path.join(root, dir);
    const names = await readdir(full, { recursive }).catch(() => []);
    return names.filter(test).map(n => path.join(dir, n)).sort();
}

// Replaces comments with spaces (newlines kept, so line numbers stay put) and
// returns the text plus the set of 0-based lines whose comments carry the marker.
// Strings and template literals are walked so '//' inside them is not a comment,
// and '://' (http://, https:// in JSX text) never starts one.
export function stripComments(src) {
    let out = '';
    const marked = new Set();
    const stack = [{ mode: 'code', depth: 0 }];
    let line = 0, i = 0;
    const put = ch => { out += ch; if (ch === '\n') line++; };
    const blank = ch => { out += ch === '\n' ? '\n' : ch === '\r' || ch === '\t' ? ch : ' '; if (ch === '\n') line++; };
    while (i < src.length) {
        const top = stack[stack.length - 1], ch = src[i], next = src[i + 1];
        if (top.mode === 'template') {
            if (ch === '\\') { put(ch); if (next !== undefined) put(next); i += 2; continue; }
            if (ch === '`') { put(ch); stack.pop(); i++; continue; }
            if (ch === '$' && next === '{') { put(ch); put(next); stack.push({ mode: 'code', depth: 0 }); i += 2; continue; }
            put(ch); i++; continue;
        }
        if (ch === '/' && next === '/' && src[i - 1] !== ':') {
            const end = src.indexOf('\n', i), stop = end === -1 ? src.length : end;
            if (src.slice(i, stop).includes(MARKER)) marked.add(line);
            for (; i < stop; i++) blank(src[i]);
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2), stop = end === -1 ? src.length : end + 2;
            const body = src.slice(i, stop);
            if (body.includes(MARKER)) marked.add(line + (body.match(/\n/g) || []).length);
            for (; i < stop; i++) blank(src[i]);
            continue;
        }
        if (ch === '\\') { put(ch); if (next !== undefined) put(next); i += 2; continue; }
        if (ch === "'" || ch === '"') {
            // A quote ends at its pair or at the end of the line (a stray apostrophe in JSX text).
            put(ch); i++;
            while (i < src.length && src[i] !== ch && src[i] !== '\n') {
                if (src[i] === '\\' && src[i + 1] !== undefined && src[i + 1] !== '\n') { put(src[i]); i++; }
                put(src[i]); i++;
            }
            if (src[i] === ch) { put(ch); i++; }
            continue;
        }
        if (ch === '`') { put(ch); stack.push({ mode: 'template' }); i++; continue; }
        if (ch === '{' && stack.length > 1) top.depth++;
        if (ch === '}' && stack.length > 1) {
            if (top.depth === 0) { put(ch); stack.pop(); i++; continue; }
            top.depth--;
        }
        put(ch); i++;
    }
    return { text: out, marked };
}

export function lint(file, src) {
    const hits = [];
    const { text, marked } = stripComments(src);
    text.split('\n').forEach((content, n) => {
        if (marked.has(n - 1)) return;
        for (const word of [...BANNED, ...RETIRED]) if (content.includes(word)) hits.push({ file, line: n + 1, word, text: content.trim() });
        for (const re of BANNED_PATTERNS) if (re.test(content)) hits.push({ file, line: n + 1, word: String(re), text: content.trim() });
    });
    return hits;
}

const isTs = f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts');

// The scanner checks itself first, so a broken comment stripper cannot pass silently:
// JSX text is caught, comments and marked lines are skipped, '://' and '//' in strings are not comments.
function selfTest() {
    const sample = [
        '<p>등급 혜택은 준비 중이에요</p>',
        "const a = 'https://x.kr'; // 준비 중",
        '<a href="https://thecheat.co.kr">https://thecheat.co.kr 돼요</a>',
        '/* 돼요',
        '   예요 */ const t = `${ok ? `—` : "//"} 한눈에` // 예요',
        '// copy-lint-ignore-next-line',
        "const quick = ['쿨거 가능해요', '안 돼요'];",
        "{/* copy-lint-ignore-next-line */}",
        '<p>돼요</p>',
        '<span>인증·등급</span>',
        '<p>가격을 제안할 수도 있어요 (선택)</p>',
        "<p>{register ? '이미 계정이 있나요?' : '아직 회원이 아닌가요?'}</p>",
    ].join('\n');
    const got = lint('self', sample).map(h => `${h.line}:${h.word}`).join(' ');
    const want = '1:준비 중 1:이에요 3:돼요 5:한눈에 5:— 10:인증·등급 11:있어요 11:제안 11:(선택) 12:나요? 12:가요?';
    if (got === want) return true;
    console.error(`copy-lint self-test failed: got "${got}", want "${want}"`);
    return false;
}

async function main() {
    if (!selfTest()) return 1;
    const targets = [
        ...await files('src', true, isTs),
        ...await files('shared', false, isTs),
        ...await files('worker', false, isTs),
    ];
    if (!targets.length) { console.error('copy-lint: no source files found'); return 1; }
    const hits = [];
    let code = '';
    for (const file of targets) {
        const src = await readFile(path.join(root, file), 'utf8');
        hits.push(...lint(file.split(path.sep).join('/'), src));
        code += stripComments(src).text + '\n';
    }
    const missing = REQUIRED.filter(s => !code.includes(s));
    if (missing.length) {
        for (const s of missing) console.error(`copy-lint: required wording missing: '${s}'`);
        return 1;
    }
    if (hits.length) {
        for (const h of hits) console.error(`${h.file}:${h.line}: '${h.word}'  ${h.text.length > 160 ? h.text.slice(0, 160) + '…' : h.text}`);
        console.error(`copy-lint: ${hits.length} forbidden phrase(s) found in ${targets.length} files.`);
        return 1;
    }
    console.log(`PASS copy-lint (${targets.length} files)`);
    return 0;
}

// Importing the module (for its lint/stripComments helpers) does not run the scan.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
