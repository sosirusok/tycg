// Local stand-in for Naver's OAuth 2.0 token endpoint and profile API (네이버 로그인). The Worker started
// with TEST_HOOKS=on, NAVER_AUTH_BASE=<origin> and NAVER_API_BASE=<origin> sends its calls here for requests
// to 127.0.0.1. Listens on 127.0.0.1 only, on a free port. Nothing here ever calls Naver.
//
//   POST /oauth2.0/token   form: grant_type=authorization_code, client_id, client_secret, code, state.
//                          code 'ok:<naver id>' gives a fresh access token for that id; any other code an error.
//                          'ok:<naver id>|<mobile>' sets the mobile number ('-': none); otherwise it is made
//                          from the id (mockMobile), so different ids have different numbers.
//   GET  /v1/nid/me        Bearer <token>: {resultcode:'00', response:{id, mobile, nickname, name, email, profile_image}}.
//                          The extra fields are there so tests can check the Worker never keeps or shows them.
//   GET  /oauth2.0/authorize  for screen checks in a browser: straight back to redirect_uri with
//                          code 'ok:<random id>' and the same state (verify-naver calls the callback itself).
//   GET  /__log            every call so far (the form fields without the secret, and the tokens handed out).
//
// Standalone (for screen checks): node tests/fixtures/naver-mock.mjs [port]
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MOCK_PROFILE = { nickname: '네이버별명목', name: '홍길동목업', email: 'mock-user@naver.example', profile_image: 'https://phinf.example/mock.png' };

// The default mobile number of a mock Naver id: 010-XXXX-XXXX from a hash of the id.
export function mockMobile(id) {
    const n = String(parseInt(createHash('sha256').update(id).digest('hex').slice(0, 12), 16) % 1e8).padStart(8, '0');
    return `010-${n.slice(0, 4)}-${n.slice(4)}`;
}

export function startNaverMock(port = 0, { clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
    const tokens = new Map(), log = [];
    let origin = '';
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://mock');
        const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
        if (url.pathname === '/__log') return send(200, { log, tokens: [...tokens.keys()] });
        if (url.pathname === '/oauth2.0/authorize' && req.method === 'GET') {
            const back = new URL(url.searchParams.get('redirect_uri') || 'http://127.0.0.1/');
            back.searchParams.set('code', 'ok:MOCK' + randomBytes(6).toString('hex'));
            back.searchParams.set('state', url.searchParams.get('state') || '');
            res.writeHead(302, { location: back.toString() });
            return res.end();
        }
        if (url.pathname === '/oauth2.0/token' && req.method === 'POST') {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const f = new URLSearchParams(raw);
            const entry = { path: url.pathname, grant_type: f.get('grant_type'), client_id: f.get('client_id'), secret_ok: f.get('client_secret') === clientSecret, code: f.get('code'), state: f.get('state') };
            log.push(entry);
            const code = f.get('code') || '';
            if (entry.grant_type !== 'authorization_code' || entry.client_id !== clientId || !entry.secret_ok || !code.startsWith('ok:')) {
                return send(200, { error: 'invalid_request', error_description: 'mock refused' });
            }
            const access = 'mock-access-' + randomBytes(12).toString('hex'), refresh = 'mock-refresh-' + randomBytes(12).toString('hex');
            tokens.set(access, code.slice(3));
            entry.access = access; entry.refresh = refresh;
            return send(200, { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: '3600' });
        }
        if (url.pathname === '/v1/nid/me' && req.method === 'GET') {
            const token = (req.headers.authorization || '').replace(/^Bearer /, '');
            log.push({ path: url.pathname, token });
            const entry = tokens.get(token);
            if (!entry) return send(401, { resultcode: '024', message: 'Authentication failed' });
            const [id, phone] = entry.split('|');
            const mobile = phone === undefined ? mockMobile(id) : phone === '-' ? undefined : phone;
            return send(200, { resultcode: '00', message: 'success', response: { id, ...mobile ? { mobile } : {}, ...MOCK_PROFILE } });
        }
        send(404, { error: 'not found' });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ origin, log, close: () => new Promise(done => server.close(() => done())) });
        });
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const m = await startNaverMock(Number(process.argv[2]) || 0);
    console.log('naver mock on ' + m.origin);
}
