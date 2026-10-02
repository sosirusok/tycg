import { toast } from 'sonner';

// Copies text with the Clipboard API, else through a hidden textarea (older in-app browsers). Resolves to
// whether it worked.
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* the fallback below */ }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch { return false; }
}

// The share address of a post (WP59): its page carries the post's og: tags for KakaoTalk and other link
// previews (worker/share.ts), and the app moves on to /posts/:id.
export const shareUrl = (id: number) => location.origin + '/p/' + id;

// 공유: phones and touch screens open the system share sheet (KakaoTalk, 문자 …) where the browser has one;
// elsewhere the address is copied ('링크 복사 완료'). Closing the sheet does nothing.
export async function sharePost(id: number, title: string) {
    const url = shareUrl(id);
    const sheet = typeof navigator.share === 'function' && window.matchMedia('(max-width: 960px), (pointer: coarse)').matches;
    if (sheet) {
        try { await navigator.share({ title, url }); return; }
        catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return; }
    }
    if (await copyText(url)) toast('링크 복사 완료');
    else toast.error('복사하지 못했습니다.');
}
