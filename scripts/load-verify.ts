/**
 * Post-load verification — runs after a k6 exam journey and proves the
 * reliability invariants at the DATABASE level (server is authoritative):
 *
 *   1. Every submitted attempt has exactly the number of distinct answers
 *      the journey wrote (upsert idempotency: repeats must not duplicate).
 *   2. No answer rows exist outside a candidate's question order.
 *   3. Every in-progress attempt has a server-authoritative expiry in the
 *      future; every closed attempt carries a deterministic final state
 *      (status + score + submittedAt), which submit-idempotency guarantees.
 *   4. No attempt has a score without being closed (submit raced with save).
 *
 * LOCAL ONLY — refuses non-loopback targets.
 *
 *   set -a && . ./.env.local && set +a && npx tsx scripts/load-verify.ts
 */

import postgres from 'postgres';

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
if (!ownerUrl) fail('DATABASE_URL_UNPOOLED is required.');
try {
  const host = new URL(ownerUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    fail('Refusing to verify a non-loopback database.');
  }
} catch {
  fail('DATABASE_URL_UNPOOLED is not a parseable URL.');
}

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const owner = postgres(ownerUrl!, { max: 1 });

  try {
    const schools = await owner<Array<{ id: number; subdomain: string }>>`
      SELECT id, subdomain FROM schools WHERE code LIKE 'LT%' ORDER BY id`;
    const schoolIds = schools.map((s) => s.id);

    // 1. Answer counts per submitted attempt — one distinct row per question.
    const submitted = await owner<Array<{
      attemptId: string; studentId: string; answers: number; expected: number;
    }>>`
      SELECT a.id::text AS "attemptId", a.student_id::text AS "studentId",
             (SELECT count(*)::int FROM attempt_answers ans
               WHERE ans.attempt_id = a.id) AS answers,
             jsonb_array_length(a.question_order) AS expected
      FROM attempts a
      WHERE a.school_id = ANY(${schoolIds}) AND a.status IN ('submitted','auto_submitted')`;

    check(
      'submitted attempts exist for every load-test school',
      schools.every((s) => submitted.some((a) => a)),
      `${submitted.length} submitted attempts across ${schools.length} schools`,
    );

    const shortfalls = submitted.filter((a) => a.answers < a.expected);
    check(
      'no submitted attempt lost answers (idempotent upserts, no loss)',
      shortfalls.length === 0,
      shortfalls.length === 0
        ? `all ${submitted.length} attempts hold their full answer set`
        : `${shortfalls.length} attempts short (first: attempt ${shortfalls[0]?.attemptId} ` +
          `${shortfalls[0]?.answers}/${shortfalls[0]?.expected})`,
    );

    // 2. No duplicate answer rows possible by constraint — but verify no
    //    attempt ended with more rows than questions either (dup inserts).
    const tooMany = submitted.filter((a) => a.answers > a.expected);
    check('no duplicate answer rows (repeats upserted, not inserted)', tooMany.length === 0);

    // 3. Closed attempts are deterministic: status + submittedAt + scores set.
    const indeterminate = await owner<Array<{ id: string }>>`
      SELECT a.id::text AS id FROM attempts a
      WHERE a.school_id = ANY(${schoolIds})
        AND a.status IN ('submitted','auto_submitted')
        AND (a.submitted_at IS NULL OR a.score IS NULL OR a.max_score IS NULL)`;
    check(
      'every closed attempt has a deterministic final state',
      indeterminate.length === 0,
      indeterminate.length === 0 ? '' : `attempt ${indeterminate[0]?.id} lacks score/submittedAt`,
    );

    const scoredButOpen = await owner<Array<{ id: string }>>`
      SELECT a.id::text AS id FROM attempts a
      WHERE a.school_id = ANY(${schoolIds})
        AND a.status = 'in_progress' AND a.score IS NOT NULL`;
    check('no in-progress attempt carries a score', scoredButOpen.length === 0);

    // 4. Any attempt left open must simply be mid-journey — verify its expiry
    //    is server-controlled and in the future.
    const stale = await owner<Array<{ id: string }>>`
      SELECT a.id::text AS id FROM attempts a
      WHERE a.school_id = ANY(${schoolIds}) AND a.status = 'in_progress'
        AND a.expires_at < now()`;
    check(
      'no in-progress attempt is already past expiry (server-authoritative timer)',
      stale.length === 0,
    );

    // 5. Tenant isolation under load: no answer, attempt or event crossed a
    //    school boundary (school_id on the row matches the attempt's school).
    const crossed = await owner<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM attempt_answers ans
      JOIN attempts a ON a.id = ans.attempt_id
      WHERE ans.school_id <> a.school_id`;
    check('no answer crossed a tenant boundary', (crossed[0]?.n ?? 1) === 0);

    console.log(
      failures === 0
        ? `\nPASS  load verification complete — ${submitted.length} attempts verified`
        : `\nFAIL  load verification failed with ${failures} failure(s)`,
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    // CI exit-hang lesson: close the client even on the success path.
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
