// Bindings configured in wrangler.jsonc plus secrets set at deploy time.
interface Env {
    // Static assets (wrangler.jsonc assets.binding); missing on the local test servers without assets.
    ASSETS?: Fetcher;
    DB: D1Database;
    // Optional: when absent, uploaded photos are stored in D1 instead.
    BUCKET?: R2Bucket;
    // Optional: the KV namespace for photos while R2 is off (deploy.yml finds or creates
    // 'zombiego-market-photos' and binds it). Without both, photos are stored in D1.
    PHOTOS?: KVNamespace;
    // Initial manager credentials. Either the plain password or a PBKDF2 hash and salt.
    MANAGER_PASSWORD?: string;
    MANAGER_PASSWORD_HASH?: string;
    MANAGER_PASSWORD_SALT?: string;
    // 웹 푸시 (WP64), Worker secrets that deploy.yml creates once when the secret list lacks
    // VAPID_PRIVATE_KEY and never replaces: the P-256 private key as a JWK (JSON), its public key
    // (base64url of the 65-byte point) and the subject (the site's https address). Without the private
    // key or the subject, push is off and the app never offers '알림 켜기'.
    VAPID_PRIVATE_KEY?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_SUBJECT?: string;
    // 네이버 로그인 (worker/naver.ts), Worker secrets that deploy.yml passes from the GitHub secrets of the
    // same names when they are set. Without both, members cannot sign in and /api/auth/naver/start says so.
    // NAVER_CLIENT_SECRET also keys the HMAC of the short-lived login cookies.
    NAVER_CLIENT_ID?: string;
    NAVER_CLIENT_SECRET?: string;
    // Optional: the Callback URL registered at 네이버 개발자센터, when it is not <request origin>/api/auth/naver/callback.
    NAVER_REDIRECT_URI?: string;
    // Keys users.phone_hash (같은 휴대전화번호 중복 가입 방지) and, through HKDF (info 'zg-pii-v1'), the AES-GCM key of
    // users.pii (네이버 회원 정보, worker/pii.ts). Set once; changing it stops older hashes matching and older 회원
    // 정보 opening (each member's is written again at the next Naver login).
    PHONE_HASH_KEY?: string;
    // The manager's mobile number as digits (01012345678): the Naver account with that number signs in as the
    // manager account (worker/naver.ts callback). Optional; without it the manager links Naver in 설정 or uses
    // /manager-login.
    MANAGER_PHONE?: string;
    // Test only: with TEST_HOOKS=on, requests to 127.0.0.1 or localhost send the token call to NAVER_AUTH_BASE
    // and the profile call to NAVER_API_BASE (tests/fixtures/naver-mock.mjs). Set by scripts/test-local.mjs only.
    NAVER_AUTH_BASE?: string;
    NAVER_API_BASE?: string;
    // Test only: 'on' keeps the old ID/password sign-up and login for requests to 127.0.0.1 or localhost, so
    // the API suites can make members without Naver. Set by scripts/test-local.mjs only; deploys never do.
    LEGACY_AUTH_TEST?: string;
    // Test only: 'on' lets a request to 127.0.0.1 or localhost subscribe an http://127.0.0.1 endpoint (the
    // mock push service of tests/verify-push.mjs). Set by scripts/test-local.mjs only; deploys never do.
    PUSH_TEST?: string;
    // Test only: 'relaxed' lifts the post caps (open posts, posts per day, same title) for requests
    // to 127.0.0.1 or localhost. scripts/test-local.mjs sets it for the API suites; deploys never do.
    POST_LIMITS?: string;
    // Test only: 'on' turns on the read and call meter (worker/meter.ts) for requests to 127.0.0.1 or
    // localhost and for scheduled runs. scripts/test-local.mjs sets it; wrangler.jsonc and deploys never do.
    READ_BUDGET?: string;
    // Test only: 'on' makes every KV put and delete throw (local requests and scheduled runs), as on a
    // day past KV Free's limits. scripts/test-local.mjs sets it on one short-lived server; deploys never do.
    KV_TEST_FAIL?: string;
    // Test only: 'on' lets local requests send X-Test-Db-Bytes (the database size for the D1 photo
    // guard) and X-Test-Storage (store one upload in KV or D1), and makes the 자동 끌올 ticks use the
    // test event's scheduledTime as now. Set by scripts/test-local.mjs only.
    TEST_HOOKS?: string;
    // Test only: the origin of a local fixture server (tests/fixtures/preview-server.mjs) that every
    // 링크 미리보기 fetch goes to, honoured only for saves served on 127.0.0.1 (worker/unfurl.ts).
    // Set by scripts/test-local.mjs only; deploys never do.
    PREVIEW_TEST_ORIGIN?: string;
}

declare module 'cloudflare:workers' {
    export const env: Env;
}

// Minimal typing for AsyncLocalStorage, which `nodejs_compat` provides (the test meter).
declare module 'node:async_hooks' {
    export class AsyncLocalStorage<T> {
        run<R>(store: T, fn: () => R): R;
        getStore(): T | undefined;
    }
}

// Minimal typing for the Node Buffer that `nodejs_compat` provides (base64 codec).
declare module 'node:buffer' {
    export const Buffer: {
        from(data: Uint8Array): { toString(encoding: 'base64'): string };
        from(data: string, encoding: 'base64'): Uint8Array;
    };
}
