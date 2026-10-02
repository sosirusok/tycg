// 좀비고 거래소 service worker (WP64): 웹 푸시 only. It has no fetch handler and caches nothing, so pages
// load exactly as without it. The pushes carry no data: on each push it reads the member's newest unread
// 알림 or chat (GET /api/notifications/latest) and always shows one notification.
const SITE_NAME = '좀비고 거래소';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function latest() {
    try {
        const res = await fetch('/api/notifications/latest', { credentials: 'include', cache: 'no-store' });
        // Signed out on this device (or the session ended): this browser stops getting pushes. The push
        // service then answers 410 and the site deletes the subscription.
        if (res.status === 401) {
            const sub = await self.registration.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
            return null;
        }
        return res.ok ? (await res.json()).push || null : null;
    } catch {
        return null;
    }
}

self.addEventListener('push', event => {
    event.waitUntil(latest().then(n => self.registration.showNotification(n?.title || SITE_NAME, {
        body: n?.body || '새 알림이 있습니다.',
        icon: '/icons/app-192.png',
        badge: '/icons/app-badge.png',
        lang: 'ko',
        // One notification per chat or 알림 row: a newer push for the same one replaces it on screen silently.
        tag: n?.tag || 'zg',
        data: { url: n?.url || '/', id: n?.id ?? null },
    })));
});

// A tap opens its page: the window already there, else any window of the site, else a new one. A 알림
// opened outside the 알림함 is marked read, as tapping it in the 알림함 does.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const { url, id } = event.notification.data || {};
    const target = new URL(url || '/', self.location.origin).href;
    const open = async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const same = windows.find(w => w.url === target);
        if (same) return same.focus();
        const any = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (any) {
            try {
                await any.focus();
                return await any.navigate(target);
            } catch { /* not controlled by this worker: open a window instead */ }
        }
        return self.clients.openWindow(target);
    };
    const read = () => typeof id === 'number'
        ? fetch('/api/notifications/read', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {})
        : Promise.resolve();
    event.waitUntil(Promise.all([open(), read()]));
});
