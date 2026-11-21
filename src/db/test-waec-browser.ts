/**
 * The WAEC Standard checkbox in a real browser: it follows the level's stage setting, not its name, and it says
 * why when it is missing. LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-waec-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? ''); assert(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert(process.env.QUESTION_BROWSER_MODULE, 'browser runtime required');
  const { schema, client } = await import('@/db');
  const { saveCollection } = await import('@/lib/exam/collection');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  try {
    const [school] = await db.insert(schema.schools).values({ name: 'WAEC UI', code: 'WU-' + randomUUID() }).returning(); schoolId = school!.id;
    const mk = async (role: 'principal' | 'teacher', loginId: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: loginId, firstName: 'T', lastName: loginId }).returning();
      return { user: user!, staff: staff! };
    };
    const principal = await mk('principal', 'principal'), teacher = await mk('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const mkLevel = async (name: string, stage: 'junior' | 'senior' | 'both') => {
      const [lvl] = await db.insert(schema.classLevels).values({ schoolId, name, stage }).returning();
      const [room] = await db.insert(schema.classes).values({ schoolId, levelId: lvl!.id, displayName: name + ' A' }).returning();
      return { lvl: lvl!, room: room! };
    };
    const year10 = await mkLevel('Year 10', 'senior'), ss1prep = await mkLevel('SS1 Prep', 'junior');
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    for (const [sub, l] of [[english!, year10], [english!, ss1prep], [maths!, year10]] as const)
      await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: sub.id, classId: l.room.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    await saveCollection({ schoolId, userId: principal.user.id, role: 'principal', staffId: principal.staff.id, studentId: null, loginId: 'principal' }, { objective: 1, theory: 1, seriesId: series!.id });

    const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: teacher.user.id, expiresAt: new Date(Date.now() + 1800000) });
    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      const open = async (subjectId: number, levelId: number) => {
        await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
        await page.locator('#qs-subject').selectOption(String(subjectId));
        await page.locator('#qs-class').selectOption(`${levelId}:`);
        await page.waitForURL(/setId=/); await page.waitForLoadState('networkidle');
      };
      const waecBox = () => page.getByRole('checkbox', { name: /WAEC Standard/ });

      await check('English in a senior level called "Year 10" offers WAEC Standard', async () => {
        await open(english!.id, year10.lvl.id); await waecBox().waitFor();
        assert.equal(await page.getByTestId('waec-why').count(), 0);
      });
      await check('ticking it opens a WAEC set for that level, and the choice survives the reload', async () => {
        await waecBox().check(); await page.waitForURL(/waecMode=1/); await page.waitForLoadState('networkidle');
        assert.equal(await waecBox().isChecked(), true);
        const sets = await db.select().from(schema.questionSets).where(eq(schema.questionSets.schoolId, schoolId));
        assert.ok(sets.some((s) => s.waecMode && s.levelId === year10.lvl.id));
      });
      await check('English in a JUNIOR level named "SS1 Prep" does not, and says why', async () => {
        await open(english!.id, ss1prep.lvl.id);
        assert.equal(await waecBox().count(), 0);
        const why = await page.getByTestId('waec-why').textContent();
        assert.match(why ?? '', /senior classes/); assert.match(why ?? '', /junior in Classes/);
      });
      await check('Mathematics in a senior level shows no WAEC option and no confusing note', async () => {
        await open(maths!.id, year10.lvl.id);
        assert.equal(await waecBox().count(), 0); assert.equal(await page.getByTestId('waec-why').count(), 0);
      });
      await check('a forged request for a WAEC set on the junior level is refused by the server, and creates nothing', async () => {
        const before = (await db.select().from(schema.questionSets).where(eq(schema.questionSets.schoolId, schoolId))).length;
        await page.goto(new URL(`/portal/questions?subjectId=${english!.id}&levelId=${ss1prep.lvl.id}&departmentId=&examType=objective&delivery=cbt&marks=1&method=manual&waecMode=1`, base).href, { waitUntil: 'networkidle' });
        assert.equal((await db.select().from(schema.questionSets).where(eq(schema.questionSets.schoolId, schoolId))).length, before, 'no set was created');
        assert.equal((await db.select().from(schema.questionSets).where(eq(schema.questionSets.levelId, ss1prep.lvl.id))).filter((s) => s.waecMode).length, 0);
      });
      await check('changing the level to senior in Classes makes the option appear (no name involved)', async () => {
        await db.update(schema.classLevels).set({ stage: 'senior' }).where(eq(schema.classLevels.id, ss1prep.lvl.id));
        await open(english!.id, ss1prep.lvl.id); await waecBox().waitFor();
      });
      await check('the browser raised no runtime errors', async () => assert.deepEqual(errors, []));
    } finally { await browser.close(); }
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
