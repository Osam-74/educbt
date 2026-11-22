/**
 * Whole-class report sheets (plugin: Bulk Report) over real HTTP. The class print is built on the single report, so the
 * checks prove (1) who may print which class, (2) only published sheets print, (3) order, (4) one sheet per page, and
 * (5) a sheet in the run is the very sheet the single report shows. LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 npx tsx src/db/test-class-reports.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { reportFixtureEnv } from './report-fixture';

async function main() {
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? ''); assert(['127.0.0.1', 'localhost'].includes(base.hostname));
  const env = await reportFixtureEnv(); const { schema, db } = env;
  let checks = 0; const failed: string[] = [];
  async function check(name: string, test: () => Promise<unknown>) {
    try { await test(); checks++; console.log('PASS  ' + name); } catch (e) { failed.push(name); console.log('FAIL  ' + name + ' :: ' + String((e as Error).message).split('\n')[0]?.slice(0, 110)); }
  }
  try {
    const f = await env.build({ crest: true });
    await f.compile(f.classA.id); await f.move(f.classA.id, 'reviewed'); await f.move(f.classA.id, 'published');
    await f.compile(f.classB.id);                                   // class B: compiled, NOT published
    const tokens = {
      principal: await env.sessionToken(f.principalUser.id),
      teacher: await env.sessionToken(f.teacherUser.id),            // class teacher of A
      otherTeacher: await env.sessionToken(f.otherTeacherUser.id),  // class teacher of B only
      student: await env.sessionToken(f.studentUser.id),
    };
    const get = async (path: string, token?: string) => {
      const r = await fetch(new URL(path, base), { headers: token ? { cookie: 'educbt.session=' + token } : {}, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      return { status: r.status, html: await r.text(), location: r.headers.get('location') ?? '' };
    };
    const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    const url = (classId: number, term = f.term.id) => `/portal/reports/class?class=${classId}&term=${term}`;
    const sheetCount = (html: string) => (html.match(/class="doc__sheet /g) ?? []).length;
    const names = (html: string) => [...text(html).matchAll(/Name:<\/td><td><strong>([A-Za-z]+) ([A-Za-z]+)<\/strong>/g)].map((m) => `${m[2]} ${m[1]}`);

    await check('signed out: sent to sign in, nothing printed', async () => {
      const r = await get(url(f.classA.id)); assert.equal(r.status, 307); assert.ok(!r.html.includes('doc__sheet'));
    });
    await check('principal prints the whole published class: 5 sheets', async () => {
      const r = await get(url(f.classA.id), tokens.principal); assert.equal(r.status, 200); assert.equal(sheetCount(r.html), 5);
    });
    await check('the class teacher prints their own class', async () => {
      const r = await get(url(f.classA.id), tokens.teacher); assert.equal(r.status, 200); assert.equal(sheetCount(r.html), 5);
    });
    await check('another class teacher is refused: no sheets, plain message', async () => {
      const r = await get(url(f.classA.id), tokens.otherTeacher); assert.equal(sheetCount(r.html), 0); assert.match(r.html, /only print report sheets for a class you hold/);
    });
    await check('a student has no class print: refused, no sheets', async () => {
      const r = await get(url(f.classA.id), tokens.student); assert.equal(sheetCount(r.html), 0); assert.match(r.html, /only print report sheets for a class you hold/);
    });
    await check('an unpublished class prints nothing and says so, with the enrolled count', async () => {
      const r = await get(url(f.classB.id), tokens.principal); assert.equal(sheetCount(r.html), 0); assert.match(r.html, /No published results found/); assert.match(text(r.html), /2 enrolled\./);
    });
    await check('a class that does not exist is refused', async () => {
      const r = await get(url(999999999), tokens.principal); assert.equal(sheetCount(r.html), 0); assert.match(r.html, /only print report sheets for a class you hold/);
    });
    await check('no class chosen asks for one', async () => {
      const r = await get('/portal/reports/class', tokens.principal); assert.match(r.html, /Choose a class/);
    });
    await check('sheets are in order of LAST name, then first name', async () => {
      const r = await get(url(f.classA.id), tokens.principal);
      assert.deepEqual(names(r.html), ['Adeyemi Ife', 'Bello Adam', 'Bello Chi', 'Okoro Zara', 'Yusuf Musa']);
    });
    await check('every sheet after the first starts a new page; the first does not (no blank leading or trailing page)', async () => {
      const r = await get(url(f.classA.id), tokens.principal);
      assert.equal((r.html.match(/break-before:page/g) ?? []).length, 4, 'a break before sheets 2 to 5 only');
      assert.ok(!/class="doc" style="[^"]*break-before/.test(r.html.split('doc__sheet')[0] ?? ''), 'no break before the first sheet');
    });
    await check('a sheet in the run is the very sheet the single report shows (same marks, same position)', async () => {
      const bulk = await get(url(f.classA.id), tokens.principal); const one = await get(`/portal/reports/${f.studentsA[3]!.id}?term=${f.term.id}`, tokens.principal);
      const rowsOf = (h: string) => [...h.matchAll(/<td[^>]*>\s*([0-9]+(?:\.[0-9])?)\s*<\/td>/g)].map((m) => m[1]).join(',');
      const bulkSheet = bulk.html.split('doc__sheet ').find((p) => p.includes('Ife') && p.includes('Adeyemi')) ?? '';
      assert.ok(bulkSheet.length > 500); assert.equal(rowsOf(bulkSheet), rowsOf(one.html.split('doc__sheet ')[1] ?? ''));
    });
    await check('the toolbar and the remark editors do NOT appear in the run (those belong to a single sheet)', async () => {
      const r = await get(url(f.classA.id), tokens.principal); assert.equal((r.html.match(/Download \/ Print/g) ?? []).length, 1, 'one toolbar for the whole run');
    });
    await check('the results page offers "Report sheets" for the class', async () => {
      await db.update(schema.terms).set({ isCurrent: true }).where(eq(schema.terms.id, f.term.id));
      const r = await get('/portal/results', tokens.principal); assert.ok(r.html.includes(`/portal/reports/class?class=${f.classA.id}&amp;term=${f.term.id}`), 'link present'); assert.match(r.html, /Report sheets/);
    });
    await check('another school cannot print this school\'s class', async () => {
      const g = await env.build(); const outsider = await env.sessionToken(g.principalUser.id);
      const r = await get(url(f.classA.id), outsider); assert.equal(sheetCount(r.html), 0);
    });
    await check('a student left unpublished is left out and counted, the rest still print', async () => {
      await db.update(schema.subjectResults).set({ published: false, state: 'reviewed' as never }).where(eq(schema.subjectResults.studentId, f.studentsA[4]!.id));
      const r = await get(url(f.classA.id), tokens.principal); assert.equal(sheetCount(r.html), 4); assert.match(text(r.html), /1 of 5 students left out/);
    });
  } finally { await env.cleanup(); }
  if (failed.length) { console.log(`\nFAILED: ${checks} passed, ${failed.length} failed`); process.exitCode = 1; } else console.log(`\nOK: ${checks} passed, 0 failed`);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
