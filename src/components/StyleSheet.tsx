import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { AArrowUp, AlignCenter, Baseline, Bold, Highlighter, RemoveFormatting, Strikethrough, Underline } from 'lucide-react';
import { toast } from 'sonner';
import { STYLE_ERROR, STYLE_MAX_MARKS, applyTool, codesFor, covers, groupValue, lineRange, type Mark, type StyleCode } from '../../shared/richtext';
import { RichBody } from './RichBody';
import { useMoreRight } from './ui';

// 글자 꾸미기 sheet (WP49, design 6). Typing stays in the editor's textarea; here the body is shown as it
// will read on the post, the member selects text and taps a tool. Only the tools of the member's grade
// are shown: no locked tools and no upsell.

// Characters of root's text before (node, offset): every character of the body is one text node in
// order (RichBody), so the text before the point is its offset.
function offsetOf(root: HTMLElement, node: Node, offset: number) {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return r.toString().length;
}
function pointAt(root: HTMLElement, at: number): [Node, number] {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null, left = at, last: Node | null = null;
    while ((n = walk.nextNode())) {
        const len = (n as Text).data.length;
        if (left <= len) return [n, left];
        left -= len;
        last = n;
    }
    return last ? [last, (last as Text).data.length] : [root, 0];
}

const COLORS: [StyleCode | null, string, string][] = [[null, '기본', 'k0'], ['c1', '파랑', 'k1'], ['c2', '빨강', 'k2'], ['c3', '회색', 'k3']];
const SIZES: [StyleCode | null, string, string][] = [['z1', '작게', 'z1'], [null, '기본', 'z0'], ['z2', '크게', 'z2'], ['z3', '아주 크게', 'z3']];

export default function StyleSheet({ body, marks, rank, onChange, onClose }: { body: string; marks: Mark[]; rank: number; onChange: (marks: Mark[]) => void; onClose: () => void }) {
    const box = useRef<HTMLDivElement>(null);
    // The last selection inside the body, kept while a tool is tapped.
    const [range, setRange] = useState<[number, number] | null>(null);
    const [pop, setPop] = useState<'color' | 'size' | null>(null);
    const tools = useMoreRight<HTMLDivElement>();
    const allowed = codesFor(rank), has = (c: StyleCode) => allowed.includes(c);

    useEffect(() => {
        const on = () => {
            const sel = document.getSelection(), root = box.current;
            if (!sel || !root || !sel.rangeCount) return;
            const r = sel.getRangeAt(0);
            // A tap on a tool or outside the body keeps the last range.
            if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return;
            if (r.collapsed) { setRange(null); return; }
            const a = offsetOf(root, r.startContainer, r.startOffset), b = offsetOf(root, r.endContainer, r.endOffset);
            setRange(a < b ? [a, b] : null);
        };
        document.addEventListener('selectionchange', on);
        return () => document.removeEventListener('selectionchange', on);
    }, []);
    // After a tool re-renders the body, the same characters stay selected.
    useLayoutEffect(() => {
        const root = box.current, sel = document.getSelection();
        if (!root || !sel || !range) return;
        const [sn, so] = pointAt(root, range[0]), [en, eo] = pointAt(root, range[1]);
        const cur = sel.rangeCount ? sel.getRangeAt(0) : null;
        if (cur && root.contains(cur.startContainer) && offsetOf(root, cur.startContainer, cur.startOffset) === range[0] && offsetOf(root, cur.endContainer, cur.endOffset) === range[1]) return;
        try { sel.setBaseAndExtent(sn, so, en, eo); } catch { /* the node moved; the next selection fixes it */ }
    }, [marks]);

    const [a, b] = range || [0, 0];
    function use(next: Mark[]) {
        if (next.length > STYLE_MAX_MARKS) { toast.error(STYLE_ERROR); return; }
        onChange(next);
    }
    const toggle = (code: StyleCode) => {
        if (!range) return;
        const [x, y] = code === 'ac' ? lineRange(body, a, b) : [a, b];
        use(applyTool(body, marks, a, b, { code, on: !covers(marks, x, y, code) }));
    };
    const pressed = (code: StyleCode) => {
        if (!range) return false;
        const [x, y] = code === 'ac' ? lineRange(body, a, b) : [a, b];
        return covers(marks, x, y, code);
    };
    // Tools never take the focus or the selection away from the body.
    const keep = (e: { preventDefault: () => void }) => e.preventDefault();
    const tool = (code: StyleCode, label: string, icon: ReactNode) => has(code) && <button type="button" className="style-tool" aria-label={label} title={label}
        aria-pressed={pressed(code)} disabled={!range} onPointerDown={keep} onMouseDown={keep} onClick={() => { setPop(null); toggle(code); }}>{icon}</button>;
    const color = groupValue(marks, a, b, 'c'), size = groupValue(marks, a, b, 'z');

    return <Dialog.Root open onOpenChange={o => { if (!o) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content className="modal modal-wide style-sheet" aria-describedby={undefined} onOpenAutoFocus={e => e.preventDefault()}>
                <div className="modal-head">
                    <Dialog.Title asChild><h2>꾸미기</h2></Dialog.Title>
                    <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>완료</button>
                </div>
                <div className="style-tools-wrap" onPointerDown={keep} onMouseDown={keep}>
                    <div ref={tools.ref} className={'style-tools' + (tools.more ? ' has-more' : '')} role="toolbar" aria-label="꾸미기" onScroll={tools.measure}>
                        {tool('b', '굵게', <Bold size={20} />)}
                        {has('u') && <span className="style-sep" />}
                        {tool('u', '밑줄', <Underline size={20} />)}
                        {tool('s', '취소선', <Strikethrough size={20} />)}
                        {has('c1') && <><span className="style-sep" />
                            <button type="button" className="style-tool" aria-label="글자색" title="글자색" aria-expanded={pop === 'color'} aria-pressed={!!color} disabled={!range}
                                onPointerDown={keep} onMouseDown={keep} onClick={() => setPop(pop === 'color' ? null : 'color')}><Baseline size={20} /></button></>}
                        {has('z1') && <><span className="style-sep" />
                            <button type="button" className="style-tool" aria-label="글자 크기" title="글자 크기" aria-expanded={pop === 'size'} aria-pressed={!!size} disabled={!range}
                                onPointerDown={keep} onMouseDown={keep} onClick={() => setPop(pop === 'size' ? null : 'size')}><AArrowUp size={20} /></button></>}
                        {has('h') && <span className="style-sep" />}
                        {tool('h', '배경 강조', <Highlighter size={20} />)}
                        {tool('ac', '가운데 정렬', <AlignCenter size={20} />)}
                        {has('u') && <><span className="style-sep" />
                            <button type="button" className="style-tool" aria-label="꾸미기 지우기" title="꾸미기 지우기" disabled={!range}
                                onPointerDown={keep} onMouseDown={keep} onClick={() => { setPop(null); if (range) use(applyTool(body, marks, a, b, { clear: true })); }}><RemoveFormatting size={20} /></button></>}
                    </div>
                    {pop === 'color' && range && <div className="style-pop" role="group" aria-label="글자색">
                        {COLORS.map(([code, label, k]) => <button key={label} type="button" className={'swatch ' + k} aria-label={label} title={label} aria-pressed={color === code || (!code && !color)}
                            onPointerDown={keep} onMouseDown={keep} onClick={() => { setPop(null); use(applyTool(body, marks, a, b, { group: 'c', code })); }} />)}
                    </div>}
                    {pop === 'size' && range && <div className="style-pop sizes" role="group" aria-label="글자 크기">
                        {SIZES.map(([code, label, k]) => <button key={label} type="button" className={'size-opt ' + k} aria-pressed={size === code || (!code && !size)}
                            onPointerDown={keep} onMouseDown={keep} onClick={() => { setPop(null); use(applyTool(body, marks, a, b, { group: 'z', code })); }}>{label}</button>)}
                    </div>}
                </div>
                <div className="style-scroll">
                    <div ref={box} className="style-body"><RichBody text={body} marks={marks} inert /></div>
                    <p className="style-hint">꾸밀 글자 선택 후 버튼</p>
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
