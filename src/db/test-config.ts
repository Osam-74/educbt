/**
 * The connection-contract regression suite.
 *
 *   npm run test:config
 *
 * Needs NO database and NO real credentials — the contract is pure logic over
 * an environment object, so every case here is deterministic and rerun-safe.
 *
 * What it locks down:
 *
 *   1. Production boots only on the least-privileged app-role URL.
 *      A missing, blank, or whitespace-only DATABASE_URL_APP must fail closed,
 *      and a privileged-looking DATABASE_URL must NOT be silently used.
 *   2. The failure message names the variable to set but never echoes a
 *      connection string — URLs carry passwords.
 *   3. Development keeps its documented fallback so a fresh clone works.
 *   4. No environment variable is exposed to the client bundle (NEXT_PUBLIC_),
 *      and no application code (src/app, src/lib) touches the owner/migration
 *      credential — that stays in scripts and db tooling.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeDatabaseUrl } from './connection';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const FAKE_APP_URL = 'postgresql://educbt_app:not-a-real-password@ep-pooler.example/educbt';
const FAKE_OWNER_URL = 'postgresql://owner:owner-secret-value@ep-direct.example/educbt';

function resolve(env: Record<string, string | undefined>, nodeEnv?: string) {
  return resolveRuntimeDatabaseUrl(env, nodeEnv);
}

// ── Production: fail closed without the app-role connection ────────────────

{
  const r = resolve({ DATABASE_URL_APP: FAKE_APP_URL }, 'production');
  check('production + app-role URL accepted', r.ok && r.ok && r.url === FAKE_APP_URL && r.viaAppRole);
}

{
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL }, 'production');
  const rejected = !r.ok && r.error.includes('DATABASE_URL_APP');
  check('production + missing app-role URL rejected', rejected,
    rejected ? '' : 'must fail, not fall back');
}

{
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL, DATABASE_URL_APP: '   ' }, 'production');
  check('production + blank app-role URL rejected', !r.ok,
    'whitespace-only is not a configured connection');
}

{
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL }, 'production');
  // The single most important case: an owner-shaped general URL must never be
  // reached for in production, no matter how tempting the fallback looks.
  const noLeak = !r.ok || !r.url;
  check('production never falls back to the general URL', noLeak,
    noLeak ? '' : `fell back to ${r.ok && r.url!.split('@')[1]}`);
}

{
  const r = resolve({}, 'production');
  check('production with nothing configured rejected', !r.ok && r.error.includes('DATABASE_URL_APP'));
}

// ── Error hygiene: names the variable, never the secret ─────────────────────

{
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL }, 'production');
  const msg = r.ok ? '' : r.error;
  check('failure names the variable to set', msg.includes('DATABASE_URL_APP'));
  check('failure never echoes the connection string',
    !msg.includes('owner-secret-value') && !msg.includes('ep-direct.example'),
    'connection URLs contain passwords');
}

// ── Development: the documented fallback stays intact ───────────────────────

{
  const r = resolve({ DATABASE_URL_APP: FAKE_APP_URL }, 'development');
  check('development + app-role URL preferred', r.ok && r.ok && r.viaAppRole);
}

{
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL }, 'development');
  check('development falls back to the general URL', r.ok && r.ok && !r.viaAppRole,
    'documented exception: fresh clones have no educbt_app yet');
}

{
  const r = resolve({}, 'development');
  check('development with nothing configured rejected', !r.ok);
}

{
  // tsx scripts and local tools run with NODE_ENV unset; unset must behave
  // like development, not like production.
  const r = resolve({ DATABASE_URL: FAKE_OWNER_URL }, undefined);
  check('unset NODE_ENV behaves as development', r.ok && r.ok && !r.viaAppRole);
}

// ── Secret safety: nothing reaches the client bundle ────────────────────────

// Test suites are tooling, not shipped code; they legitimately quote these
// patterns while asserting no application code ever reads them.
const isTest = (f: string) =>
  /(^|\/)test-[^/]*\.tsx?$/.test(f.split('/src/')[1] ?? f);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...walk(p, exts));
    } else if (exts.some((e) => p.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

{
  const files = walk(join(process.cwd(), 'src'), ['.ts', '.tsx']).filter((f) => !isTest(f));
  // Match the access pattern, not the bare name: this suite legitimately
  // mentions NEXT_PUBLIC_ in prose while asserting no code ever reads it.
  const publicLeak = files.filter((f) =>
    readFileSync(f, 'utf8').includes('process.env.NEXT_PUBLIC_'));
  check('no NEXT_PUBLIC_ variables exist (all env is server-only)',
    publicLeak.length === 0,
    publicLeak.slice(0, 3).map((f) => f.split('/src/')[1]).join(', '));
}

{
  // The owner/migration credential belongs to scripts and db tooling only.
  // Application code importing it would let a page route run DDL.
  const appCode = [
    ...walk(join(process.cwd(), 'src/app'), ['.ts', '.tsx']),
    ...walk(join(process.cwd(), 'src/lib'), ['.ts', '.tsx']),
  ].filter((f) => !isTest(f));
  const offenders = appCode.filter((f) =>
    readFileSync(f, 'utf8').includes('process.env.DATABASE_URL_UNPOOLED'));
  check('application code never touches the migration credential',
    offenders.length === 0,
    offenders.slice(0, 3).map((f) => f.split('/src/')[1]).join(', '));
}

console.log(
  `\n${failures === 0 ? 'Connection contract holds.' : `${failures} config check(s) FAILED.`}`,
);
process.exit(failures === 0 ? 0 : 1);
