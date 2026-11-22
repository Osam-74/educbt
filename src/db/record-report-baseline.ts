/**
 * Records the single report sheet's exact HTML for a fixed set of students, so a refactor can be proven to change
 * nothing a reader sees. Usage: OUT=/tmp/report-before npx tsx src/db/record-report-baseline.ts
 * Needs the local server (CA_TEST_HTTP_URL). Disposable LOCAL database only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { reportFixtureEnv } from './report-fixture';

async function main() {
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? ''); assert(['127.0.0.1', 'localhost'].includes(base.hostname));
  const out = process.env.OUT; assert(out, 'OUT directory required'); mkdirSync(out, { recursive: true });
  const env = await reportFixtureEnv();
  try {
    const f = await env.build({ crest: true });
    await f.compile(f.classA.id); await f.move(f.classA.id, 'reviewed'); await f.move(f.classA.id, 'published');
    await f.compile(f.classB.id);                                   // class B stays compiled, NOT published
    const principalToken = await env.sessionToken(f.principalUser.id);
    const teacherToken = await env.sessionToken(f.teacherUser.id);
    const studentToken = await env.sessionToken(f.studentUser.id);
    const get = async (path: string, token: string) => {
      const r = await fetch(new URL(path, base), { headers: { cookie: 'educbt.session=' + token }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.text() };
    };
    // Ids and the term id differ between runs, so they are replaced by stable placeholders before saving.
    const stable = (html: string) => html
      .replace(new RegExp(`/portal/reports/\\d+`, 'g'), '/portal/reports/ID').replace(/term=\d+/g, 'term=T')
      .replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ').replace(/data-dpl-id="[^"]*"/g, '').replace(/\/_next\/static\/[^"')]+/g, '/_next/static/X');
    const cases: Array<[string, string, string]> = [];
    f.studentsA.forEach((s, i) => cases.push([`A${i + 1}-principal`, `/portal/reports/${s.id}?term=${f.term.id}`, principalToken]));
    cases.push(['A1-teacher', `/portal/reports/${f.studentsA[0]!.id}?term=${f.term.id}`, teacherToken]);
    cases.push(['A1-own-student', `/portal/reports/${f.studentsA[0]!.id}?term=${f.term.id}`, studentToken]);
    cases.push(['A2-other-student-denied', `/portal/reports/${f.studentsA[1]!.id}?term=${f.term.id}`, studentToken]);
    f.studentsB.forEach((s, i) => cases.push([`B${i + 1}-unpublished-principal`, `/portal/reports/${s.id}?term=${f.term.id}`, principalToken]));
    cases.push(['missing-student', `/portal/reports/999999999?term=${f.term.id}`, principalToken]);
    for (const [name, path, token] of cases) {
      const r = await get(path, token);
      writeFileSync(`${out}/${name}.txt`, `STATUS ${r.status}\n${stable(r.body)}\n`);
      console.log(name.padEnd(28), r.status, String(r.body.length).padStart(7), 'bytes');
    }
  } finally { await env.cleanup(); }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
