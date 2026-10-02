// Bindings configured in wrangler.jsonc plus secrets set at deploy time.
interface Env {
    ASSETS: Fetcher;
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
