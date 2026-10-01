// Static migration check (no server, no database): every migration from 0016 on, the round-3
// numbering, must be additive and safe while the previous Worker still serves. Each file has its
// own 4-digit prefix and holds no DROP, no RENAME and no table rebuild (CREATE TABLE … AS, or
// INSERT INTO … SELECT followed by a DROP). Comments are ignored. No dependencies:
// node tests/verify-migrations.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FIRST_CHECKED = 16;

// SQL without -- and /* */ comments; quoted strings are kept so a '--' inside one stays.
export function stripSql(sql) {
    let out = '', i = 0;
    while (i < sql.length) {
        const ch = sql[i], next = sql[i + 1];
        if (ch === "'" || ch === '"' || ch === '`') {
            const end = sql.indexOf(ch, i + 1), stop = end === -1 ? sql.length : end + 1;
            out += sql.slice(i, stop); i = stop; continue;
        }
        if (ch === '-' && next === '-') { const end = sql.indexOf('\n', i); i = end === -1 ? sql.length : end; continue; }
        if (ch === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; out += ' '; continue; }
        out += ch; i++;
    }
    return out;
}

// The problems of one migration's SQL (an empty list when it is additive).
export function problems(sql) {
    const text = stripSql(sql).replace(/'(?:[^']|'')*'/g, "''");
    const found = [];
    if (/\bDROP\b/i.test(text)) found.push('DROP');
    if (/\bRENAME\b/i.test(text)) found.push('RENAME');
    if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b[^;]*?\bAS\s+SELECT\b/i.test(text)) found.push('CREATE TABLE … AS');
    if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b[^;]*?\bSELECT\b[\s\S]*\bDROP\b/i.test(text)) found.push('INSERT INTO … SELECT then DROP');
    return found;
}

function selfTest() {
    const cases = [
        ['ALTER TABLE `users` ADD `x` integer DEFAULT 0 NOT NULL; -- DROP is fine in a comment', []],
        ["INSERT INTO settings(key,value) VALUES('note','DROP TABLE x');", []],
        ['DROP INDEX a;', ['DROP']],
        ['ALTER TABLE a RENAME TO b;', ['RENAME']],
        ['CREATE TABLE b AS SELECT * FROM a;', ['CREATE TABLE … AS']],
        ['CREATE TABLE b (id integer); INSERT INTO b SELECT * FROM a; DROP TABLE a;', ['DROP', 'INSERT INTO … SELECT then DROP']],
        ['CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, \'x\'); END; /* DROP */', []],
    ];
    for (const [sql, want] of cases) {
        const got = problems(sql);
        if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`verify-migrations self-test failed for ${sql}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); return false; }
    }
    return true;
}

async function main() {
    if (!selfTest()) return 1;
    const names = (await readdir(path.join(root, 'migrations'))).filter(n => n.endsWith('.sql')).sort();
    const errors = [];
    const prefixes = new Map();
    let checked = 0;
    for (const name of names) {
        const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
        if (!m) { if (Number(name.slice(0, 4)) >= FIRST_CHECKED || !/^\d{4}_/.test(name)) errors.push(`${name}: the name must be NNNN_name.sql`); continue; }
        const n = Number(m[1]);
        if (n < FIRST_CHECKED) continue;
        checked++;
        if (prefixes.has(m[1])) errors.push(`${name}: the number ${m[1]} is already used by ${prefixes.get(m[1])}`);
        prefixes.set(m[1], name);
        for (const p of problems(await readFile(path.join(root, 'migrations', name), 'utf8'))) errors.push(`${name}: ${p} is not allowed (additive migrations only)`);
    }
    if (errors.length) { errors.forEach(e => console.error('verify-migrations: ' + e)); return 1; }
    console.log(`PASS verify-migrations (${checked} migrations from ${String(FIRST_CHECKED).padStart(4, '0')})`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
