/**
 * Phase 3 — chaos / reliability suite.
 *
 * Drives the REAL HTTP surface of a running app (local/test/staging only —
 * refuse production hosts by policy) through the failure modes an exam hall
 * actually produces, then verifies the invariants at the database level:
 *
 *   C1  duplicate answer request          → one row, idempotent
 *   C2  offline then reconnect            → delayed save accepted
 *   C3  refresh mid-exam                  → same attempt, same question order
 *   C4  browser close/reopen              → resume, not restart
 *   C5  simultaneous two-device activity  → both devices' answers land
 *   C6  timer expiry while disconnected    → saves rejected, no restart
 *   C7  submit/expiry race                 → deterministic closed state
 *   C8  force-submit / submit race         → single final state
 *   C9  repeated submit                    → idempotent no-op
 *   C10 answer save racing submit          → no error, consistent score
 *
 * The suite shares ONE postgres.js client and closes it in finally — the
 * CI-hang lesson from docs/rapid-completion-report.md.
 *
 *   set -a && . ./.env.local && set +a && npx tsx scripts/chaos-suite.ts
 */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const BASE = process.env.CHAOS_BASE_URL ?? 'http://127.0.0.1:3017';
// The app resolves the tenant from the Host header; Node's fetch pins Host to
// the URL authority, so the tenant hostname must be IN the URL (for local runs
// the load*.localhost hosts map to 127.0.0.1 via /etc/hosts).
const url = new URL(BASE);
function base(host: string): string {
  const u = new URL(BASE); u.hostname = host;
  return u.toString().replace(/\/$/, '');
}
const manifest = JSON.parse(readFileSync('load/manifest.json', 'utf8')) as Array<{
  subdomain: string; host: string; paperId: number; password: string;
  candidates: string[]; answers: Array<{ questionId: number; optionId: number }>;
}>;
const school = manifest[0]!;
const alt = manifest[1]!;

const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED is required (set -a && . ./.env.local && set +a).');
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(ownerUrl).hostname)) {
  throw new Error('Refusing to run the chaos suite against a non-loopback database.');
}
const sql = postgres(ownerUrl, { max: 1 });

let passed = 0; let failed = 0;
function ok(name: string, condition: boolean, detail = '') {
  if (condition) { passed++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function htmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseActionFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<input[^>]*name="(\$ACTION[^"]*)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const tag = m[0]!;
    const name = /name="([^"]*)"/.exec(tag)![1]!;
    const vm = /value="([^"]*)"/.exec(tag);
    fields[name] = vm ? htmlUnescape(vm[1]!) : '';
  }
  return fields;
}

async function signIn(loginId: string): Promise<string> {
  const page = await fetch(`${base(school.host)}/sign-in`);
  const body = await page.text();
  const fields = parseActionFields(body);
  const boundary = `chaos${Math.random().toString(16).slice(2)}`;
  let mp = '';
  for (const [k, v] of Object.entries({ ...fields, next: '/portal', loginId, password: school.password, totpCode: '' })) {
    mp += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  mp += `--${boundary}--\r\n`;
  const res = await fetch(`${BASE}/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Origin: base(school.host),
      // next start derives x-forwarded-host from the connection host for
      // server-action requests; Node fetch's Host pin confuses it. Send the
      // tenant explicitly so the action-origin gate matches.
      'x-forwarded-host': new URL(base(school.host)).host },
    body: mp, redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  const token = /educbt\.session=([^;]+)/.exec(cookie)?.[1];
  if (!token) throw new Error(`sign-in failed for ${loginId} (status ${res.status})`);
  return token;
}

function h(token: string): Record<string, string> {
  return { Cookie: `educbt.session=${token}` };
}

async function startExam(token: string): Promise<number> {
  const res = await fetch(`${base(school.host)}/exam/${school.paperId}`, { headers: h(token) });
  const body = await res.text();
  const m = /attemptId[\\"']*:\s*(\d+)/.exec(body);
  if (!m) throw new Error(`exam start failed (status ${res.status})`);
  return Number(m[1]);
}

async function save(token: string, attemptId: number, questionId: number, optionId: number, key?: string) {
  const res = await fetch(`${base(school.host)}/api/exam/${attemptId}/answer`, {
    method: 'POST', headers: { ...h(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, optionId, key: key ?? `${attemptId}:${questionId}:${optionId}` }),
  });
  return { status: res.status, body: await res.text() };
}

async function submit(token: string, attemptId: number) {
  const res = await fetch(`${base(school.host)}/api/exam/${attemptId}/submit`, {
    method: 'POST', headers: { ...h(token), 'Content-Type': 'application/json' }, body: '' });
  return { status: res.status, body: await res.text() };
}

async function attemptRow(attemptId: number) {
  const rows = await sql`SELECT id, status, question_order, score, submitted_at, submit_reason, expires_at
    FROM attempts WHERE id = ${attemptId}`;
  return rows[0]!;
}
async function answerCount(attemptId: number) {
  const rows = await sql`SELECT count(*)::int AS n FROM attempt_answers WHERE attempt_id = ${attemptId}`;
  return rows[0]!.n as number;
}

async function main() {
  const fresh = 'DELETE FROM attempts WHERE school_id IN (SELECT id FROM schools WHERE subdomain LIKE $1)';
  await sql.unsafe(fresh, ['load%']);
  console.log('chaos suite — attempts reset for load schools\n');

  // C1 — duplicate answer request: the browser retries a save it is unsure of.
  {
    const t = await signIn('cand091'); const a = await startExam(t);
    const q = school.answers[0]!;
    const [r1, r2] = await Promise.all([save(t, a, q.questionId, q.optionId), save(t, a, q.questionId, q.optionId)]);
    ok('C1 both duplicate saves accepted', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
    const n = await answerCount(a);
    ok('C1 exactly one answer row', n === 1, `rows=${n}`);
    await submit(t, a);
  }

  // C2 — offline then reconnect: a save after a network gap still lands.
  {
    const t = await signIn('cand092'); const a = await startExam(t);
    const q = school.answers[1]!;
    await new Promise(r => setTimeout(r, 3000)); // the "gap"
    const r = await save(t, a, q.questionId, q.optionId);
    ok('C2 delayed save accepted', r.status === 200, `status=${r.status}`);
    const row = await attemptRow(a);
    ok('C2 attempt still open after gap', row.status === 'in_progress');
    await submit(t, a);
  }

  // C3 — refresh mid-exam: same attempt, same question order.
  {
    const t = await signIn('cand093'); const a = await startExam(t);
    const before = await attemptRow(a);
    const again = await fetch(`${base(school.host)}/exam/${school.paperId}`, { headers: h(t) });
    const body = await again.text();
    const m = /attemptId[\\"']*:\s*(\d+)/.exec(body);
    ok('C3 refresh resumes the same attempt', m !== null && Number(m[1]) === a);
    const after = await attemptRow(a);
    ok('C3 question order unchanged', JSON.stringify(before.question_order) === JSON.stringify(after.question_order));
    await submit(t, a);
  }

  // C4 — browser close/reopen: a NEW session resumes, never restarts.
  {
    const t1 = await signIn('cand094'); const a = await startExam(t1);
    const t2 = await signIn('cand094'); // the reopened browser
    const res = await fetch(`${base(school.host)}/exam/${school.paperId}`, { headers: h(t2) });
    const body = await res.text();
    const m = /attemptId[\\"']*:\s*(\d+)/.exec(body);
    ok('C4 second session resumes same attempt', m !== null && Number(m[1]) === a);
    const rows = await sql`SELECT count(*)::int AS n FROM attempts WHERE id = ${a}`;
    ok('C4 no second attempt created', rows[0]!.n === 1);
    await submit(t2, a);
  }

  // C5 — simultaneous two-device activity: both devices write concurrently.
  {
    const tA = await signIn('cand095'); const tB = await signIn('cand095');
    const a = await startExam(tA);
    const qs = school.answers.slice(0, 6)!;
    const results = await Promise.all([
      ...qs.slice(0, 3).map(q => save(tA, a, q.questionId, q.optionId)),
      ...qs.slice(3, 6).map(q => save(tB, a, q.questionId, q.optionId)),
    ]);
    ok('C5 both devices saved without error', results.every(r => r.status === 200),
      results.map(r => r.status).join(','));
    const n = await answerCount(a);
    ok('C5 all answers landed once', n === 6, `rows=${n}`);
    // Same question from both devices concurrently → one row, one option.
    const q = school.answers[6]!;
    await Promise.all([save(tA, a, q.questionId, q.optionId), save(tB, a, q.questionId, q.optionId)]);
    const rows = await sql`SELECT option_id FROM attempt_answers WHERE attempt_id = ${a} AND question_id = ${q.questionId}`;
    ok('C5 concurrent same-question writes collapse to one row', rows.length === 1);
    await submit(tA, a);
  }

  // C6 — timer expiry while disconnected: server time, not the client.
  {
    const t = await signIn('cand096'); const a = await startExam(t);
    const q = school.answers[0]!;
    await save(t, a, q.questionId, q.optionId);
    await sql`UPDATE attempts SET expires_at = now() - interval '2 minutes' WHERE id = ${a}`;
    const r = await save(t, a, school.answers[1]!.questionId, school.answers[1]!.optionId);
    ok('C6 save after expiry rejected', r.status === 409, `status=${r.status} body=${r.body.slice(0, 60)}`);
    const body = await (await fetch(`${base(school.host)}/exam/${school.paperId}`, { headers: h(t) })).text();
    const m = /attemptId[\\"']*:\s*(\d+)/.exec(body);
    ok('C6 expired attempt is not restarted', m !== null && Number(m[1]) === a);
    const n = await answerCount(a);
    ok('C6 pre-expiry answers retained', n === 1, `rows=${n}`);
    const sub = await submit(t, a); // cleanup: close the attempt deterministically
    ok('C6 submit after expiry closes cleanly', sub.status === 200, `status=${sub.status}`);
  }

  // C7 — submit/expiry race: expiry + submit fire together.
  {
    const t = await signIn('cand097'); const a = await startExam(t);
    const q = school.answers[0]!;
    await save(t, a, q.questionId, q.optionId);
    await sql`UPDATE attempts SET expires_at = now() - interval '30 seconds' WHERE id = ${a}`;
    const [s1, r1] = await Promise.all([submit(t, a), save(t, a, q.questionId, q.optionId)]);
    const row = await attemptRow(a);
    ok('C7 attempt closed deterministically', row.status !== 'in_progress', `status=${row.status}`);
    ok('C7 score is set', row.score !== null, `score=${row.score}`);
    ok('C7 submit response ok', s1.status === 200, `status=${s1.status}`);
    void r1;
  }

  // C8 — force-submit / submit race: several submits at once.
  {
    const t = await signIn('cand098'); const a = await startExam(t);
    const q = school.answers[0]!;
    await save(t, a, q.questionId, q.optionId);
    const res = await Promise.all([submit(t, a), submit(t, a), submit(t, a)]);
    ok('C8 all racing submits accepted', res.every(r => r.status === 200), res.map(r => r.status).join(','));
    const row = await attemptRow(a);
    ok('C8 single closed final state', row.status !== 'in_progress' && row.score !== null,
      `status=${row.status} score=${row.score}`);
  }

  // C9 — repeated submit after closure: a retry is a no-op.
  {
    const t = await signIn('cand099'); const a = await startExam(t);
    const q = school.answers[0]!;
    await save(t, a, q.questionId, q.optionId);
    await submit(t, a);
    const score1 = (await attemptRow(a)).score;
    const r2 = await submit(t, a); const r3 = await submit(t, a);
    ok('C9 repeated submits stay ok', r2.status === 200 && r3.status === 200);
    const score2 = (await attemptRow(a)).score;
    ok('C9 score unchanged across resubmits', String(score1) === String(score2), `${score1} vs ${score2}`);
  }

  // C10 — answer save racing submit: no lost update, no 5xx.
  {
    const t = await signIn('cand100'); const a = await startExam(t);
    const q = school.answers[0]!;
    await save(t, a, q.questionId, q.optionId);
    const [s, w] = await Promise.all([submit(t, a), save(t, a, school.answers[1]!.questionId, school.answers[1]!.optionId)]);
    const row = await attemptRow(a);
    const n = await answerCount(a);
    ok('C10 no 5xx in save/submit race', s.status < 500 && w.status < 500, `submit=${s.status} save=${w.status}`);
    ok('C10 final state consistent', row.status !== 'in_progress' && n >= 1,
      `status=${row.status} answers=${n} score=${row.score}`);
  }

  // Cross-tenant sanity: an attempt from ANOTHER school is invisible.
  {
    const t = await signIn('cand100');
    const foreign = await sql`SELECT a.id FROM attempts a JOIN schools s ON s.id = a.school_id
      WHERE s.subdomain = ${alt.subdomain} ORDER BY a.id DESC LIMIT 1`;
    if (foreign.length > 0) {
      const r = await save(t, Number(foreign[0]!.id), 1, 1);
      ok('TENANT answer save across schools refused', r.status !== 200, `status=${r.status}`);
    }
  }

  console.log(`\nchaos suite — ${passed} passed, ${failed} failed`);
}

main()
  .catch(e => { console.error('CHAOS SUITE ERROR:', e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
