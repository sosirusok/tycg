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
const BANNED = [
    '할 수 있어요', '해 보세요', '준비 중', '돼요', '이에요', '예요',
    '가격 제안', '제안하기', '제안을', '반갑습니다', '환영합니다',
    '한눈에', '손쉽게', '편리하게', '간편하게', '혜택을 누려',
    '→', '—', '인증·등급',
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
        for (const word of BANNED) if (content.includes(word)) hits.push({ file, line: n + 1, word, text: content.trim() });
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
    ].join('\n');
    const got = lint('self', sample).map(h => `${h.line}:${h.word}`).join(' ');
    const want = '1:준비 중 1:이에요 3:돼요 5:한눈에 5:— 10:인증·등급';
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
    for (const file of targets) hits.push(...lint(file.split(path.sep).join('/'), await readFile(path.join(root, file), 'utf8')));
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
