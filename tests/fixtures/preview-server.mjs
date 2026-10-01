// Local fixture for 링크 미리보기 (WP48). The Worker started with PREVIEW_TEST_ORIGIN=<this origin> sends
// every preview fetch here as <origin>/<host><path>, so each test host below is one route. Listens on
// 127.0.0.1 only, on a free port. GET /__hits returns how many requests each host/path received.
// Standalone (for screen checks): node tests/fixtures/preview-server.mjs [port]
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const html = (head, body = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const og = (title, extra = '') => `<title>문서 제목</title><meta property="og:title" content="${title}"><meta property="og:description" content="${title} 설명"><meta property="og:site_name" content="예시 사이트">${extra}`;

export function startPreviewServer(port = 0) {
    const hits = new Map();
    let origin = '';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/__hits') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(Object.fromEntries(hits)));
            return;
        }
        const [, host = '', ...rest] = url.pathname.split('/');
        const path = '/' + rest.join('/');
        hits.set(host + path, (hits.get(host + path) || 0) + 1);
        const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body); };
        const page = (head, body) => send(200, 'text/html; charset=utf-8', html(head, body));
        switch (host) {
            case 'og.example': return page(og('미리보기 ' + path));
            case 'open.kakao.com': return page(og('좀비고 거래 오픈채팅', '<meta property="og:image" content="https://open.kakaocdn.net/dn/room.jpg">'));
            case 'cdnimg.example': return page(og('카카오 이미지', '<meta property="og:image" content="https://k.kakaocdn.net/dn/abc.jpg">'));
            case 'otherimg.example': return page(og('다른 이미지', '<meta property="og:image" content="https://evil.example/track.png">'));
            case 'entity.example': return page(`<meta property="og:title" content="A &amp; B &lt;좀비&gt; &#x1F600; \u202Eevil\u202C ${'긴'.repeat(150)}"><meta name="og:description" content="줄&#10;바꿈">`);
            case 'title.example': return page('<title>  태그 제목 &quot;따옴표&quot; </title>');
            case 'big.example': {
                // og:title in the first bytes, og:description only after 65 KB, then </head>.
                const head = og('큰 문서').replace(/<meta property="og:description"[^>]*>/, '') + '<!--' + 'x'.repeat(66 * 1024) + '--><meta property="og:description" content="64KB 넘어서 있는 설명">';
                return page(head);
            }
            case 'png.example': return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            case 'euc.example': return send(200, 'text/html; charset=euc-kr', html(og('EUC 문서')));
            case 'notfound.example': return send(404, 'text/html', html(og('없음')));
            case 'redir-ip.example': return send(302, 'text/html', '', { location: `${origin}/og.example/ip` });
            case 'redir-local.example': return send(302, 'text/html', '', { location: 'https://intranet.local/x' });
            case 'redir-ok.example': return send(301, 'text/html', '', { location: 'https://og.example/after-redirect' });
            case 'loop.example': return send(302, 'text/html', '', { location: `https://loop.example/${Number(rest[0] || 0) + 1}` });
            case 'www.youtube.com':
                if (path === '/oembed') return send(200, 'application/json', JSON.stringify({ title: '좀비고 래더 하이라이트', author_name: '좀비고 채널' }));
                return send(404, 'text/plain', 'no');
            default: return send(404, 'text/plain', 'unknown fixture host');
        }
    });
    return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
            origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ origin, hits, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) });
        });
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const s = await startPreviewServer(Number(process.argv[2]) || 0);
    console.log(s.origin);
}
