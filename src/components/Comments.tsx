import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ImagePlus, LoaderCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { relativeTime, type Post } from '../../shared/market';
import { api, errorText, imageUrl, uploadPhoto } from '../lib/api';
import { Link } from '../lib/router';
import { useApp } from '../app/state';
import { Avatar, Modal, NameLine, SkeletonRows } from './ui';
import { RichBody } from './RichBody';
import { Lightbox } from './Lightbox';

// 댓글·답글 (WP55), the same for every grade: 3,000 characters and 1 photo each, one level of 답글, the
// '작성자' tag, and 자동 링크 without previews. GET posts/:id/comments gives 50 top-level 댓글 a page in
// 등록순, each followed by its 답글; a post with no 댓글 asks for nothing.
export const COMMENT_MAX = 3000;

export type Comment = {
    id: number; parent_id: number | null; deleted: boolean; created_at: number;
    body?: string; image?: string | null; edited?: boolean; author_id?: string; nickname?: string; role?: string; author_deleted?: boolean;
    author_grade?: string; author_grade_trial?: boolean; author_badges?: string[]; is_post_author?: boolean;
};
type Page = { comments: Comment[]; hasMore: boolean; page: number; count: number };

// One text box with the photo button, the count and '등록'. Ctrl/⌘+Enter also sends.
function Composer({ onSend, autoFocus = false, onCancel }: { onSend: (body: string, imageId: string | null) => Promise<boolean>; autoFocus?: boolean; onCancel?: () => void }) {
    const [text, setText] = useState(''), [photo, setPhoto] = useState<string | null>(null), [uploading, setUploading] = useState(false), [sending, setSending] = useState(false);
    const file = useRef<HTMLInputElement>(null), box = useRef<HTMLTextAreaElement>(null);
    // The box grows with its text up to 8 lines, then scrolls.
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight + 2, 220) + 'px';
    }, [text]);
    async function pick(files: FileList | null) {
        const f = files?.[0];
        if (!f) return;
        setUploading(true);
        try { setPhoto(await uploadPhoto(f)); }
        catch (e) { toast.error(errorText(e)); }
        finally { setUploading(false); if (file.current) file.current.value = ''; }
    }
    async function send() {
        if (sending || uploading || !text.trim()) return;
        setSending(true);
        const ok = await onSend(text, photo);
        setSending(false);
        if (ok) { setText(''); setPhoto(null); }
    }
    const key = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } };
    return <div className="comment-composer">
        <textarea ref={box} className="comment-input" rows={1} maxLength={COMMENT_MAX} value={text} onChange={e => setText(e.target.value)} onKeyDown={key} placeholder="댓글 입력" aria-label="댓글 입력" autoFocus={autoFocus} />
        {photo && <span className="comment-attach">
            <img src={imageUrl(photo)} alt="" />
            <button type="button" className="comment-attach-x" aria-label="사진 빼기" onClick={() => setPhoto(null)}><X size={14} /></button>
        </span>}
        <div className="comment-composer-foot">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => void pick(e.target.files)} />
            <button type="button" className="icon-btn comment-photo-btn" aria-label="사진 추가" disabled={uploading || !!photo} onClick={() => file.current?.click()}>{uploading ? <LoaderCircle size={20} className="spin" /> : <ImagePlus size={20} />}</button>
            <span className="comment-count">{text.length.toLocaleString('ko-KR')}/{COMMENT_MAX.toLocaleString('ko-KR')}</span>
            <span className="grow" />
            {onCancel && <button type="button" className="btn btn-text btn-sm" onClick={onCancel}>취소</button>}
            <button type="button" className="btn btn-primary btn-sm" disabled={sending || uploading || !text.trim()} onClick={() => void send()}>등록</button>
        </div>
    </div>;
}

function CommentRow({ c, reply, canReply, canEdit, canDelete, canReport, onReply, onSaved, onDelete, onReport, onPhoto }: {
    c: Comment; reply: boolean; canReply: boolean; canEdit: boolean; canDelete: boolean; canReport: boolean;
    onReply: () => void; onSaved: (body: string) => void; onDelete: () => void; onReport: () => void; onPhoto: (id: string) => void;
}) {
    const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);
    if (c.deleted) return <li className={'comment is-deleted' + (reply ? ' is-reply' : '')} id={'c-' + c.id}><p className="comment-gone">삭제된 댓글입니다.</p></li>;
    async function save() {
        if (busy || !draft.trim()) return;
        setBusy(true);
        try { await api('comments/' + c.id, 'PATCH', { body: draft }); onSaved(draft.trim()); setEditing(false); toast('댓글 수정 완료'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const name = <NameLine nickname={c.nickname || ''} grade={c.author_grade} trial={c.author_grade_trial} role={c.role} badges={c.author_badges} compact />;
    return <li className={'comment' + (reply ? ' is-reply' : '')} id={'c-' + c.id}>
        <Avatar name={c.nickname || ''} size="sm" />
        <div className="comment-main">
            <div className="comment-head">
                {c.author_deleted ? name : <Link to={'/profile/' + c.author_id} className="comment-name">{name}</Link>}
                {c.is_post_author && <span className="comment-tag">작성자</span>}
            </div>
            {editing ? <div className="comment-edit">
                <textarea className="comment-input" rows={3} maxLength={COMMENT_MAX} value={draft} onChange={e => setDraft(e.target.value)} aria-label="댓글 수정" autoFocus />
                <div className="comment-composer-foot"><span className="grow" />
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(false)}>취소</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={() => void save()}>저장</button>
                </div>
            </div> : <div className="comment-body"><RichBody text={c.body || ''} /></div>}
            {c.image && <button type="button" className="comment-photo" aria-label="사진 크게 보기" onClick={() => onPhoto(c.image!)}><img src={imageUrl(c.image)} alt="" loading="lazy" /></button>}
            <div className="comment-meta">
                <span>{relativeTime(c.created_at)}</span>
                {canReply && <button type="button" className="comment-act" onClick={onReply}>답글</button>}
                {canEdit && !editing && <button type="button" className="comment-act" onClick={() => { setDraft(c.body || ''); setEditing(true); }}>수정</button>}
                {canDelete && <button type="button" className="comment-act" onClick={onDelete}>삭제</button>}
                {canReport && <button type="button" className="comment-act" onClick={onReport}>신고</button>}
            </div>
        </div>
    </li>;
}

// The 댓글 section under the post body. onReport opens the detail page's 신고 sheet for one 댓글.
export function Comments({ post, onReport }: { post: Post; onReport: (commentId: number) => void }) {
    const { me, requireLogin } = useApp();
    const initial = post.comment_count || 0;
    const [count, setCount] = useState(initial), [list, setList] = useState<Comment[] | null>(initial ? null : []);
    const [pages, setPages] = useState(1), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(false);
    const [replyTo, setReplyTo] = useState<number | null>(null), [removing, setRemoving] = useState<Comment | null>(null), [photo, setPhoto] = useState<string | null>(null);
    const section = useRef<HTMLElement>(null);
    // Pages 1..n again (after a write), or just the first one.
    async function load(n = 1) {
        setLoading(true);
        try {
            const got: Page[] = [];
            for (let i = 1; i <= n; i++) {
                const d = await api<Page>(`posts/${post.id}/comments?page=${i}`);
                got.push(d);
                if (!d.hasMore) break;
            }
            const all = got.flatMap(d => d.comments);
            setList([...new Map(all.map(c => [c.id, c])).values()]);
            setPages(got.length);
            setHasMore(got[got.length - 1].hasMore);
            setCount(got[got.length - 1].count);
        } catch (e) { toast.error(errorText(e)); setList(l => l || []); }
        finally { setLoading(false); }
    }
    useEffect(() => {
        setCount(post.comment_count || 0);
        setReplyTo(null);
        if (post.comment_count) void load(); else { setList([]); setHasMore(false); setPages(1); }
    }, [post.id, me?.id]);
    // An 알림 opens the post at '#comments' (WP55): scroll there once the list is in.
    useEffect(() => {
        if (list !== null && location.hash === '#comments') section.current?.scrollIntoView({ block: 'start' });
    }, [list !== null]);

    const mine = !!me && me.id === post.author_id, manager = me?.role === 'manager';
    // A hidden post takes no new 댓글 (the manager excepted); a withdrawn author's post is hidden too.
    const open = !post.hidden || manager;
    async function send(body: string, imageId: string | null, parentId: number | null) {
        try {
            const d = await api<{ id: number; count: number }>(`posts/${post.id}/comments`, 'POST', { body, imageId, parentId });
            toast('댓글 등록 완료');
            setCount(d.count);
            setReplyTo(null);
            // A new top-level 댓글 lands at the end: load through the last page.
            await load(parentId === null && hasMore ? pages + 50 : pages);
            return true;
        } catch (e) { toast.error(errorText(e)); return false; }
    }
    async function remove() {
        const c = removing;
        setRemoving(null);
        if (!c) return;
        try { const d = await api<{ count: number }>('comments/' + c.id, 'DELETE'); setCount(d.count); toast('댓글 삭제 완료'); await load(pages); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function more() {
        if (loading) return;
        setLoading(true);
        try {
            const d = await api<Page>(`posts/${post.id}/comments?page=${pages + 1}`);
            setList(prev => [...new Map([...prev || [], ...d.comments].map(c => [c.id, c])).values()]);
            setPages(d.page);
            setHasMore(d.hasMore);
            setCount(d.count);
        } catch (e) { toast.error(errorText(e)); }
        finally { setLoading(false); }
    }
    const patch = (id: number, body: string) => setList(prev => prev && prev.map(c => c.id === id ? { ...c, body, edited: true } : c));

    const rows = list || [];
    // Each top-level 댓글 is followed by its 답글; the reply box opens under the last of them.
    const lastOfThread = new Map<number, number>();
    for (const c of rows) lastOfThread.set(c.parent_id ?? c.id, c.id);
    return <section className="detail-section comments" id="comments" ref={section} aria-labelledby="comments-title">
        <h2 id="comments-title">댓글 {count.toLocaleString('ko-KR')}</h2>
        {list === null ? <SkeletonRows count={2} height={56} />
            : rows.length ? <ul className="comment-list">{rows.map(c => {
                const own = !!me && me.id === c.author_id;
                const reply = c.parent_id !== null;
                const row = <CommentRow key={c.id} c={c} reply={reply}
                    canReply={!reply && !c.deleted && open} canEdit={own && !c.deleted} canDelete={!c.deleted && (own || mine || manager)} canReport={!own && !c.deleted}
                    onReply={() => requireLogin(() => setReplyTo(r => r === c.id ? null : c.id))} onSaved={b => patch(c.id, b)} onDelete={() => setRemoving(c)}
                    onReport={() => requireLogin(() => onReport(c.id))} onPhoto={setPhoto} />;
                const thread = c.parent_id ?? c.id;
                return replyTo === thread && lastOfThread.get(thread) === c.id
                    ? [row, <li key={'reply-' + thread} className="comment-reply-box"><Composer autoFocus onCancel={() => setReplyTo(null)} onSend={(b, img) => send(b, img, thread)} /></li>]
                    : row;
            })}</ul>
            : <p className="comment-empty">댓글이 없습니다.</p>}
        {hasMore && <button type="button" className="btn btn-line more-btn" disabled={loading} onClick={() => void more()}>더 보기</button>}
        {open && <div className="comment-write">
            {/* Only where the page shows 제시하기 (Detail's canOffer). */}
            {post.kind === 'sell' && !mine && !post.hidden && post.status === 'open' && (post.accepts_offers === 1 || post.price_mode === 'offer') && <p className="comment-offer-line">가격은 제시하기로 보내면 판매자에게 바로 알림이 갑니다.</p>}
            {me ? <Composer onSend={(b, img) => send(b, img, null)} />
                : <button type="button" className="btn btn-line btn-block comment-login" onClick={() => requireLogin()}>로그인 후 댓글 등록</button>}
        </div>}
        <Lightbox images={photo ? [photo] : []} index={photo ? 0 : null} onIndex={() => {}} onClose={() => setPhoto(null)} />
        <Modal open={!!removing} onClose={() => setRemoving(null)} title="댓글 삭제" description="복구할 수 없습니다."
            footer={<><button className="btn btn-line" onClick={() => setRemoving(null)}>취소</button><button className="btn btn-danger-solid" onClick={() => void remove()}>삭제</button></>} />
    </section>;
}
