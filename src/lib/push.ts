// 웹 푸시 (WP64), the browser side: whether this browser can take pushes, the service worker (public/sw.js)
// and the subscription the Worker pushes to. Storage can be unavailable (private windows), so every
// localStorage call is guarded.
import { api } from './api';

// Chrome, Edge, Firefox, Samsung Internet, macOS Safari 16+, and iPhone or iPad (iOS 16.4+) only once the
// site is on the home screen (Safari tabs have no PushManager).
export const pushSupported = () => typeof window !== 'undefined' && window.isSecureContext
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const CLOSED_KEY = 'zg:push-closed', BOUND_KEY = 'zg:push-bound';
const CLOSED_FOR = 30 * 86400000, RESEND_AFTER = 7 * 86400000;

// '닫기' on the bar hides it for 30 days in this browser.
export function pushClosed() {
    try { const at = Number(localStorage.getItem(CLOSED_KEY)); return at > 0 && Date.now() - at < CLOSED_FOR; }
    catch { return false; }
}
export function closePush() {
    try { localStorage.setItem(CLOSED_KEY, String(Date.now())); } catch { /* shown again next time */ }
}

// The member who turned pushes on in this browser (u), the subscription (e) and when it was sent (at).
type Bound = { u: string; e: string; at: number };
function readBound(): Bound | null {
    try { const b = JSON.parse(localStorage.getItem(BOUND_KEY) || 'null'); return b && typeof b.u === 'string' && typeof b.e === 'string' ? b : null; }
    catch { return null; }
}
function writeBound(b: Bound | null) {
    try { if (b) localStorage.setItem(BOUND_KEY, JSON.stringify(b)); else localStorage.removeItem(BOUND_KEY); } catch { /* asked again next time */ }
}

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);
async function subscription() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
}

// Whether this browser already gets the member's pushes, with the site's current key.
export async function pushOn(publicKey: string, userId: string) {
    const b = readBound();
    if (!b || b.u !== userId) return false;
    const sub = await subscription().catch(() => null);
    return !!sub && sub.endpoint === b.e && sameKey(sub.options.applicationServerKey, keyBytes(publicKey));
}

// Subscribes this browser (after the member's '알림 켜기'; the permission must be granted) and hands the
// subscription to the Worker, which keeps each member's newest 3 devices. A subscription made with an
// earlier site key is replaced.
export async function subscribePush(publicKey: string, userId: string) {
    if (!await navigator.serviceWorker.getRegistration('/')) await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const reg = await navigator.serviceWorker.ready;
    const key = keyBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => false); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const j = sub.toJSON();
    await api('push/subscribe', 'POST', { endpoint: j.endpoint, keys: j.keys });
    writeBound({ u: userId, e: sub.endpoint, at: Date.now() });
}

// On sign-in, only where this member turned pushes on: a subscription the browser dropped (the service
// worker drops it once signed out) or made with an earlier site key is made again, and the binding is sent
// again weekly (the Worker deletes a subscription after 5 failed pushes). Another member signing in on the
// same browser gets nothing until they press '알림 켜기' themselves.
export async function refreshPush(publicKey: string, userId: string) {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const b = readBound();
    if (!b || b.u !== userId) return;
    if (await pushOn(publicKey, userId) && Date.now() - b.at < RESEND_AFTER) return;
    await subscribePush(publicKey, userId);
}

// Before 로그아웃: this browser stops getting the member's pushes (the browser keeps its permission).
export async function unbindPush() {
    if (!pushSupported()) return;
    writeBound(null);
    try {
        const sub = await subscription();
        if (sub) await api('push/subscribe', 'DELETE', { endpoint: sub.endpoint });
    } catch { /* the service worker unsubscribes once the Worker answers 401 */ }
}
