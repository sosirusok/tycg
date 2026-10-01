import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';

// Test meter (WP42). With READ_BUDGET=on (set only by scripts/test-local.mjs; wrangler.jsonc and
// deploy.yml never set it), every API request to 127.0.0.1 or localhost and every scheduled run
// counts its D1 rows read and written, D1 calls, D1 statements (each statement inside a batch
// counts), R2 calls, KV calls and outgoing fetches. handleApi returns them as X-Rows-Read, X-Rows-Written,
// X-D1-Calls and X-D1-Statements; scheduled() stores them in settings 'sys:last_cron_meter'.
// The D1 limits page gives 50 queries per Worker invocation on Free and does not say how
// statements inside a batch count, so scheduled code is held to ≤ 45 statements plus fetches.
export type Meter = { rowsRead: number; rowsWritten: number; d1Calls: number; d1Statements: number; r2Calls: number; kvCalls: number; fetches: number };

const store = new AsyncLocalStorage<Meter>();
const newMeter = (): Meter => ({ rowsRead: 0, rowsWritten: 0, d1Calls: 0, d1Statements: 0, r2Calls: 0, kvCalls: 0, fetches: 0 });

export const meterOn = () => (env as Partial<Env>).READ_BUDGET === 'on';
export function localRequest(req: Request) {
    const host = new URL(req.url).hostname;
    return host === '127.0.0.1' || host === 'localhost';
}

// Runs `fn` with a fresh meter and returns it alongside the result.
export async function metered<T>(fn: () => Promise<T>): Promise<{ result: T; meter: Meter }> {
    const meter = newMeter();
    const result = await store.run(meter, fn);
    return { result, meter };
}

export const currentMeter = () => store.getStore();
export function countR2(n = 1) { const m = store.getStore(); if (m) m.r2Calls += n; }
export function countKv(n = 1) { const m = store.getStore(); if (m) m.kvCalls += n; }
export function countFetch(n = 1) { const m = store.getStore(); if (m) m.fetches += n; }

export function meterHeaders(m: Meter): Record<string, string> {
    return { 'X-Rows-Read': String(m.rowsRead), 'X-Rows-Written': String(m.rowsWritten), 'X-D1-Calls': String(m.d1Calls), 'X-D1-Statements': String(m.d1Statements), 'X-R2-Calls': String(m.r2Calls), 'X-KV-Calls': String(m.kvCalls), 'X-Fetches': String(m.fetches) };
}

type Meta = { rows_read?: number; rows_written?: number } | undefined;
function add(m: Meter, meta: Meta) {
    m.rowsRead += Number(meta?.rows_read) || 0;
    m.rowsWritten += Number(meta?.rows_written) || 0;
}

// A prepared statement that reports to the meter. first() goes through all(), since first() has no meta.
class MeteredStatement {
    constructor(readonly real: D1PreparedStatement, private readonly m: Meter) {}
    bind(...values: unknown[]) { return new MeteredStatement(this.real.bind(...values), this.m) as unknown as D1PreparedStatement; }
    async all<T = Record<string, unknown>>() {
        this.m.d1Calls++; this.m.d1Statements++;
        const r = await this.real.all<T>();
        add(this.m, r.meta);
        return r;
    }
    async run<T = Record<string, unknown>>() {
        this.m.d1Calls++; this.m.d1Statements++;
        const r = await this.real.run<T>();
        add(this.m, r.meta);
        return r;
    }
    async first<T = Record<string, unknown>>(column?: string) {
        const r = await this.all<Record<string, unknown>>();
        const row = r.results[0];
        if (row === undefined) return null;
        return (column === undefined ? row : row[column] ?? null) as T;
    }
    async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
        this.m.d1Calls++; this.m.d1Statements++;
        return this.real.raw<T>(options as { columnNames: true }) as Promise<T[]>;
    }
}

const wrapped = new WeakMap<D1Database, WeakMap<Meter, D1Database>>();

// The D1 binding as handed out by db(): unchanged unless a meter is running.
export function meteredDb(real: D1Database): D1Database {
    const m = store.getStore();
    if (!m) return real;
    let byMeter = wrapped.get(real);
    if (!byMeter) wrapped.set(real, byMeter = new WeakMap());
    const hit = byMeter.get(m);
    if (hit) return hit;
    const d = {
        prepare: (sql: string) => new MeteredStatement(real.prepare(sql), m) as unknown as D1PreparedStatement,
        batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
            m.d1Calls++; m.d1Statements += statements.length;
            const r = await real.batch<T>(statements.map(s => s instanceof MeteredStatement ? s.real : s));
            for (const x of r) add(m, x.meta);
            return r;
        },
        exec: async (sql: string) => { m.d1Calls++; m.d1Statements++; return real.exec(sql); },
        dump: () => real.dump(),
        withSession: (c?: string) => real.withSession(c),
    } as unknown as D1Database;
    byMeter.set(m, d);
    return d;
}
