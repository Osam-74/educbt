/**
 * Who may open a WAEC-structured set, enforced by the server (a hidden checkbox is not authorisation).
 * Isolated fixture school, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { findOrCreateSet } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  try {
    const [school] = await db.insert(schema.schools).values({ name: 'WAEC test', code: 'WE-' + randomUUID() }).returning(); schoolId = school!.id;
    const actors: Record<string, Actor> = {};
    for (const name of ['principal', 'teacher']) {
      const role = name as 'principal' | 'teacher';
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: name, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: name, firstName: 'T', lastName: name }).returning();
      actors[name] = { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: name };
    }
    const teacher = actors.teacher!;
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const mkLevel = async (name: string, stage: 'junior' | 'senior' | 'both') => {
      const [lvl] = await db.insert(schema.classLevels).values({ schoolId, name, stage }).returning();
      const [room] = await db.insert(schema.classes).values({ schoolId, levelId: lvl!.id, displayName: name + ' A' }).returning();
      return { lvl: lvl!, room: room! };
    };
    const year10 = await mkLevel('Year 10', 'senior');      // a senior level whose name the old guess could never recognise
    const ss1prep = await mkLevel('SS1 Prep', 'junior');    // looks senior by name, is junior by setting
    const both = await mkLevel('Form 3', 'both');
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    for (const sub of [english!, maths!]) for (const l of [year10, ss1prep, both])
      await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staffId!, subjectId: sub.id, classId: l.room.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    await saveCollection(actors.principal!, { objective: 1, theory: 1, seriesId: series!.id });
    const scope = (subjectId: number, levelId: number, extra: Record<string, unknown> = {}) => ({ sessionId: session!.id, termId: term!.id, subjectId, levelId,
      departmentId: null, seriesId: 0, examType: 'objective' as const, waecMode: true, deliveryMode: 'cbt' as const, ...extra });

    await check('a senior level called "Year 10" can open a WAEC set (the old name guess refused it)', async () => {
      const set = await findOrCreateSet(teacher, scope(english!.id, year10.lvl.id));
      assert.equal(set.waecMode, true);
    });
    await check('a level set to "both" can open a WAEC set', async () => { assert.equal((await findOrCreateSet(teacher, scope(english!.id, both.lvl.id))).waecMode, true); });
    await check('a JUNIOR level cannot, even though its name says SS1', async () => {
      await assert.rejects(findOrCreateSet(teacher, scope(english!.id, ss1prep.lvl.id)), /senior classes/);
      assert.equal((await db.select().from(schema.questionSets).where(eq(schema.questionSets.levelId, ss1prep.lvl.id))).length, 0, 'nothing was created');
    });
    await check('a subject other than English cannot, however senior the level', async () => {
      await assert.rejects(findOrCreateSet(teacher, scope(maths!.id, year10.lvl.id)), /English only/);
    });
    await check('written delivery cannot be a WAEC-structured paper', async () => {
      await assert.rejects(findOrCreateSet(teacher, scope(english!.id, both.lvl.id, { examType: 'theory', deliveryMode: 'written' })), /computer|CBT/);
    });
    await check('an ordinary (non-WAEC) set on a junior level or in Maths is not affected', async () => {
      assert.equal((await findOrCreateSet(teacher, scope(maths!.id, ss1prep.lvl.id, { waecMode: false }))).waecMode, false);
      assert.equal((await findOrCreateSet(teacher, scope(english!.id, ss1prep.lvl.id, { waecMode: false }))).waecMode, false);
    });
    await check('a WAEC set and an ordinary set coexist for the same subject and level', async () => {
      const w = await findOrCreateSet(teacher, scope(english!.id, year10.lvl.id));
      const o = await findOrCreateSet(teacher, scope(english!.id, year10.lvl.id, { waecMode: false }));
      assert.notEqual(w.id, o.id);
    });
    await check('an EXISTING WAEC set stays usable after its level is later set to junior', async () => {
      const existing = await findOrCreateSet(teacher, scope(english!.id, year10.lvl.id));
      await db.update(schema.classLevels).set({ stage: 'junior' }).where(eq(schema.classLevels.id, year10.lvl.id));
      const again = await findOrCreateSet(teacher, scope(english!.id, year10.lvl.id));
      assert.equal(again.id, existing.id, 'the same set is returned, not refused');
      await assert.rejects(findOrCreateSet(teacher, scope(english!.id, year10.lvl.id, { examType: 'theory' })), /senior classes/, 'but a NEW one is refused now');
    });
    await check('the rule uses this school\'s level, never another school\'s', async () => {
      const [other] = await db.insert(schema.schools).values({ name: 'Other', code: 'WO-' + randomUUID() }).returning();
      try {
        const [foreign] = await db.insert(schema.classLevels).values({ schoolId: other!.id, name: 'Foreign senior', stage: 'senior' }).returning();
        await assert.rejects(findOrCreateSet(teacher, scope(english!.id, foreign!.id)));
      } finally { await db.delete(schema.schools).where(eq(schema.schools.id, other!.id)); }
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
