// Bindings configured in wrangler.jsonc plus secrets set at deploy time.
interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    // Optional: when absent, uploaded photos are stored in D1 instead.
    BUCKET?: R2Bucket;
    // Initial manager credentials. Either the plain password or a PBKDF2 hash and salt.
    MANAGER_PASSWORD?: string;
    MANAGER_PASSWORD_HASH?: string;
    MANAGER_PASSWORD_SALT?: string;
}

declare module 'cloudflare:workers' {
    export const env: Env;
}

// Minimal typing for the Node Buffer that `nodejs_compat` provides (base64 codec).
declare module 'node:buffer' {
    export const Buffer: {
        from(data: Uint8Array): { toString(encoding: 'base64'): string };
        from(data: string, encoding: 'base64'): Uint8Array;
    };
}
