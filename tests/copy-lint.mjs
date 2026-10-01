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
];

// Retired wording (WP40 끌올 지갑): the daily 끌올 count and its midnight reset are gone, and the
// anti-flood ceilings no longer name 예약중.
const RETIRED = ['자정에 초기화', '오늘 끌올', '거래중·예약중 글은'];
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
    '등록 완료 · 끌올 1개 사용', '끌올이 없어 최근 끌올 자리에 등록했습니다.', '개 사용 · ', '이번 글은 끌올 1개', '남은 끌올 없음',
    '개까지 새 글로 올라가고, 그 뒤로는 끌올 1개씩 씁니다.',
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
