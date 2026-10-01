// 글자 꾸미기 (WP49). The post body stays plain text (search, alerts and share cards are unchanged);
// posts.body_style holds style ranges over it, Telegram-entity style:
//   {v:1, n:<body length in UTF-16 units>, h:<FNV-1a 32 of the body, 8 hex>, m:[[start,end,code], …]}
// n and h tie the ranges to one exact body, so a body changed any other way (an old client, SQL) shows
// plain. No HTML is ever stored or rendered: each code maps to one fixed class (RichBody).
import { titleTier } from './membership';

export type StyleCode = 'b' | 'u' | 's' | 'c1' | 'c2' | 'c3' | 'z1' | 'z2' | 'z3' | 'h' | 'ac';
export type Mark = [number, number, StyleCode];
export type BodyStyle = { v: 1; n: number; h: string; m: Mark[] };

export const STYLE_CODES: readonly StyleCode[] = ['b', 'u', 's', 'c1', 'c2', 'c3', 'z1', 'z2', 'z3', 'h', 'ac'];
// The tools of each rank (cumulative): 0 일반 굵게; 1 플러스 (and the 무료 체험) + 밑줄, 취소선, 글자색;
// 2 프리미엄 + 글자 크기; 3 엘리트, 관리자 and the manager + 배경 강조, 가운데 정렬.
export const CODES_BY_RANK: readonly (readonly StyleCode[])[] = [
    ['b'],
    ['b', 'u', 's', 'c1', 'c2', 'c3'],
    ['b', 'u', 's', 'c1', 'c2', 'c3', 'z1', 'z2', 'z3'],
    ['b', 'u', 's', 'c1', 'c2', 'c3', 'z1', 'z2', 'z3', 'h', 'ac'],
];
// The author's style rank from the current grade (an ended 6-month grade drops at once): the same
// ladder as 제목 강조 (WP48).
export const styleRank = (grade: string | null | undefined, role?: string | null) => titleTier(grade, role) as number;
export const codesFor = (rank: number): readonly StyleCode[] => CODES_BY_RANK[Math.max(0, Math.min(3, Math.floor(rank) || 0))];

export const STYLE_MAX_BYTES = 12 * 1024;
export const STYLE_MAX_MARKS = 300;
export const STYLE_ERROR = '글자 꾸미기를 다시 확인해 주세요.';

// Codes that cannot overlap each other (one color, one size at a time).
export const groupOf = (c: StyleCode) => c[0] === 'c' ? 'c' : c[0] === 'z' ? 'z' : '';
const isCode = (c: unknown): c is StyleCode => typeof c === 'string' && (STYLE_CODES as readonly string[]).includes(c);
const order = (c: StyleCode) => STYLE_CODES.indexOf(c);

// FNV-1a 32 over the UTF-16 code units, as 8 lowercase hex digits.
export function fnv1a(s: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
// i falls between the two halves of a surrogate pair (an emoji cut in two).
export const splitsPair = (text: string, i: number) => i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
const lineStart = (text: string, i: number) => i === 0 || text[i - 1] === '\n';
const lineEnd = (text: string, i: number) => i === text.length || text[i] === '\n';

// Same-code ranges that overlap or touch become one; sorted by start, then by code.
export function mergeMarks(marks: Mark[]): Mark[] {
    const out: Mark[] = [];
    for (const code of STYLE_CODES) {
        const list = marks.filter(m => m[2] === code).sort((a, b) => a[0] - b[0]);
        let cur: Mark | null = null;
        for (const m of list) {
            if (cur && m[0] <= cur[1]) cur[1] = Math.max(cur[1], m[1]);
            else { if (cur) out.push(cur); cur = [m[0], m[1], code]; }
        }
        if (cur) out.push(cur);
    }
    return out.sort((a, b) => a[0] - b[0] || order(a[2]) - order(b[2]));
}

// Two different colors (or sizes) on the same character.
function conflicts(merged: Mark[]) {
    for (let i = 0; i < merged.length; i++) for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j], g = groupOf(a[2]);
        if (g && g === groupOf(b[2]) && a[2] !== b[2] && a[0] < b[1] && b[0] < a[1]) return true;
    }
    return false;
}

// The stored or sent value (a JSON string or an object) as a BodyStyle, without checking it against a
// body; null when it is not one.
export function parseStyle(raw: unknown): BodyStyle | null {
    let v: any = raw;
    if (typeof raw === 'string') {
        if (!raw || raw.length > STYLE_MAX_BYTES) return null;
        try { v = JSON.parse(raw); } catch { return null; }
    }
    if (!v || typeof v !== 'object' || v.v !== 1 || !Number.isInteger(v.n) || typeof v.h !== 'string' || !Array.isArray(v.m)) return null;
    if (!v.m.every((m: unknown) => Array.isArray(m) && m.length === 3 && Number.isInteger(m[0]) && Number.isInteger(m[1]) && isCode(m[2]))) return null;
    return { v: 1, n: v.n, h: v.h, m: v.m.map((m: Mark) => [m[0], m[1], m[2]] as Mark) };
}

// The style for a body, or null when there are no marks.
export function encodeStyle(body: string, marks: Mark[]): BodyStyle | null {
    return marks.length ? { v: 1, n: body.length, h: fnv1a(body), m: marks.map(m => [m[0], m[1], m[2]] as Mark) } : null;
}

export type Validated = { ok: true; style: BodyStyle | null } | { ok: false };
// The Worker's check of a sent style (POST and PUT /posts). raw is the body as sent; the stored body is
// raw.trim() (textField), so marks shift by the trimmed leading whitespace and are clipped at the end.
// Refused: over 12KB or 300 marks, n or h not matching the sent body, a range outside it or cutting an
// emoji in two, a code above the author's rank, 가운데 정렬 not on whole lines, and two colors (or two
// sizes) on the same characters. Marks of the same code are merged. ok with style null: nothing to store.
export function validate(input: unknown, raw: string, rank: number): Validated {
    if (input === null || input === undefined || input === '') return { ok: true, style: null };
    const size = typeof input === 'string' ? input.length : (() => { try { return JSON.stringify(input).length; } catch { return Infinity; } })();
    if (size > STYLE_MAX_BYTES) return { ok: false };
    const s = parseStyle(input);
    if (!s || s.m.length > STYLE_MAX_MARKS || s.n !== raw.length || s.h !== fnv1a(raw)) return { ok: false };
    const allowed = codesFor(rank);
    const body = raw.trim(), lead = raw.length - raw.trimStart().length;
    const kept: Mark[] = [];
    for (const [start, end, code] of s.m) {
        if (!(start >= 0 && start < end && end <= raw.length)) return { ok: false };
        if (splitsPair(raw, start) || splitsPair(raw, end)) return { ok: false };
        if (!allowed.includes(code)) return { ok: false };
        const a = Math.max(0, start - lead), b = Math.min(body.length, end - lead);
        if (b <= a) continue;
        if (code === 'ac' && !(lineStart(body, a) && lineEnd(body, b))) return { ok: false };
        kept.push([a, b, code]);
    }
    const merged = mergeMarks(kept);
    if (conflicts(merged)) return { ok: false };
    return { ok: true, style: encodeStyle(body, merged) };
}

// The marks a reader sees: only when the style still belongs to this exact body, and only the codes
// of the author's current rank.
export function filterByRank(style: BodyStyle | null, rank: number): BodyStyle | null {
    if (!style) return null;
    const allowed = codesFor(rank), m = style.m.filter(x => allowed.includes(x[2]));
    return m.length ? { ...style, m } : null;
}
export function shownStyle(stored: unknown, body: string, rank: number): BodyStyle | null {
    const s = parseStyle(stored);
    if (!s || s.n !== body.length || s.h !== fnv1a(body)) return null;
    return filterByRank(s, rank);
}

// ---- Editing (the editor and the 꾸미기 sheet) ----

// Marks after the textarea changed from prev to next: the edit is the one changed stretch between the
// common prefix and suffix. Text typed at the end of a mark joins it; text typed at its start does not.
// A mark wholly inside a deleted or replaced stretch is dropped (replace-all drops all); one reaching
// past it keeps the rest, and the new text joins it when the mark started at or before the stretch.
export function shiftOnEdit(prev: string, next: string, marks: Mark[]): Mark[] {
    if (prev === next || !marks.length) return marks;
    let a = 0;
    const max = Math.min(prev.length, next.length);
    while (a < max && prev.charCodeAt(a) === next.charCodeAt(a)) a++;
    let s = 0;
    while (s < max - a && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    // Never cut a surrogate pair in the middle (one emoji replaced by another shares a high half).
    if (a > 0 && isHigh(prev.charCodeAt(a - 1))) a--;
    if (s > 0 && isLow(prev.charCodeAt(prev.length - s))) s--;
    const oldEnd = prev.length - s, newEnd = next.length - s, d = newEnd - oldEnd, insert = a === oldEnd;
    const out: Mark[] = [];
    for (const [start, end, code] of marks) {
        // A mark wholly inside a deleted or replaced stretch goes with it.
        if (!insert && start >= a && end <= oldEnd) continue;
        const ns = start < a || (start === a && !insert) ? start : start >= oldEnd ? start + d : newEnd;
        const ne = end < a || (end === a && !insert) ? end : end >= oldEnd ? end + d : newEnd;
        out.push([ns, ne, code]);
    }
    return normalizeMarks(next, out);
}

// Marks the Worker accepts for this body: clipped, never cutting an emoji (widened to whole
// characters), 가운데 정렬 widened to whole lines, merged, and a later color or size winning over an
// earlier one on the same characters. Optionally only the codes of a rank.
export function normalizeMarks(body: string, marks: Mark[], rank?: number): Mark[] {
    const allowed = rank === undefined ? STYLE_CODES : codesFor(rank);
    let list: Mark[] = [];
    for (const m of marks) {
        if (!Array.isArray(m) || !isCode(m[2]) || !allowed.includes(m[2])) continue;
        let a = Math.max(0, Math.min(body.length, Math.floor(Number(m[0]) || 0)));
        let b = Math.max(0, Math.min(body.length, Math.floor(Number(m[1]) || 0)));
        if (splitsPair(body, a)) a--;
        if (splitsPair(body, b)) b++;
        if (m[2] === 'ac') {
            while (a > 0 && body[a - 1] !== '\n') a--;
            while (b < body.length && body[b] !== '\n') b++;
        }
        if (b <= a) continue;
        const g = groupOf(m[2]);
        if (g) list = cut(list, a, b, c => groupOf(c) === g);
        list.push([a, b, m[2]]);
    }
    return mergeMarks(list);
}

// Removes [a, b) from the marks that match.
function cut(marks: Mark[], a: number, b: number, match: (c: StyleCode) => boolean): Mark[] {
    const out: Mark[] = [];
    for (const m of marks) {
        if (!match(m[2]) || m[1] <= a || m[0] >= b) { out.push(m); continue; }
        if (m[0] < a) out.push([m[0], a, m[2]]);
        if (m[1] > b) out.push([b, m[1], m[2]]);
    }
    return out;
}

// [a, b) widened to the whole lines it touches (가운데 정렬).
export function lineRange(body: string, a: number, b: number): [number, number] {
    while (a > 0 && body[a - 1] !== '\n') a--;
    while (b < body.length && body[b] !== '\n') b++;
    return [a, b];
}

// Every character of [a, b) carries the code.
export function covers(marks: Mark[], a: number, b: number, code: StyleCode) {
    if (b <= a) return false;
    let at = a;
    for (const m of mergeMarks(marks.filter(x => x[2] === code))) {
        if (m[0] > at) return false;
        if (m[1] > at) at = m[1];
        if (at >= b) return true;
    }
    return at >= b;
}

// The tool: code on or off for [a, b) ('c'/'z' codes replace the others of their group; null for
// 기본 removes the group). 가운데 정렬 works on whole lines. clear removes every code.
export function applyTool(body: string, marks: Mark[], a: number, b: number, tool: { code: StyleCode; on: boolean } | { group: 'c' | 'z'; code: StyleCode | null } | { clear: true }): Mark[] {
    if (b <= a) return marks;
    if ('clear' in tool) {
        const [la, lb] = lineRange(body, a, b);
        return normalizeMarks(body, cut(cut(marks, a, b, c => c !== 'ac'), la, lb, c => c === 'ac'));
    }
    if ('group' in tool) {
        const rest = cut(marks, a, b, c => groupOf(c) === tool.group);
        return normalizeMarks(body, tool.code ? [...rest, [a, b, tool.code]] : rest);
    }
    const [x, y] = tool.code === 'ac' ? lineRange(body, a, b) : [a, b];
    return normalizeMarks(body, tool.on ? [...marks, [x, y, tool.code]] : cut(marks, x, y, c => c === tool.code));
}

// The one code of a group over all of [a, b), or null (none, or mixed).
export function groupValue(marks: Mark[], a: number, b: number, group: 'c' | 'z'): StyleCode | null {
    for (const code of STYLE_CODES) if (groupOf(code) === group && covers(marks, a, b, code)) return code;
    return null;
}
