/**
 * The population chart's numbers, against the real database: who is counted, who is not, and who may see which class.
 * Isolated fixture schools, removed at the end. LOCAL disposable database only.
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
  const { populationByClass } = await import('@/lib/population/service');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Pop', code: 'PO-' + randomUUID() }).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const mk = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      return { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: login } as Actor;
    };
    const principal = await mk('principal', 'principal'), vice = await mk('vice_principal', 'vice'), officer = await mk('exam_officer', 'officer');
    const classTeacher = await mk('teacher', 'ct'), subjectTeacher = await mk('teacher', 'sub'), headOfNone = await mk('teacher', 'none');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [oldSession] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/2026', isCurrent: false }).returning();
    const [jss1] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', stage: 'junior', levelOrder: 1 } as never).returning();
    const [ss1] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1', stage: 'senior', levelOrder: 10 } as never).returning();
    const room = async (levelId: number, arm: string | null, name: string) => (await db.insert(schema.classes).values({ schoolId, levelId, arm, displayName: name } as never).returning())[0]!;
    // Created in a scrambled order on purpose, so ordering must come from level then arm, not insertion.
    const ss1b = await room(ss1!.id, 'B', 'SS1 B'), ss1a = await room(ss1!.id, 'A', 'SS1 A'), jss1a = await room(jss1!.id, 'A', 'JSS1 A'), empty = await room(jss1!.id, 'Z', 'JSS1 Z');
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staffId!, classId: ss1a.id, assignmentType: 'class_teacher', status: 'active' } as never);
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: subjectTeacher.staffId!, subjectId: maths!.id, classId: ss1a.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const enrol = async (classId: number, gender: string | null, opts: { status?: string; enrolStatus?: string; sessionId?: number } = {}) => {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'P' + randomUUID().slice(0, 8), firstName: 'S', lastName: 'T', gender, status: opts.status ?? 'active' } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId, sessionId: opts.sessionId ?? session!.id, status: opts.enrolStatus ?? 'active' } as never);
      return Number(s!.id);
    };
    return { schoolId, principal, vice, officer, classTeacher, subjectTeacher, headOfNone, session: session!, oldSession: oldSession!, ss1a, ss1b, jss1a, empty, enrol };
  }
  const by = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

  try {
    await check('counts each class by gender, typed any way, with "not stated" kept in the total', async () => {
      const f = await fixture();
      for (const g of ['Male', 'm', ' MALE ']) await f.enrol(f.ss1a.id, g);
      for (const g of ['female', 'F']) await f.enrol(f.ss1a.id, g);
      await f.enrol(f.ss1a.id, null); await f.enrol(f.ss1a.id, 'other');
      const row = (await populationByClass(f.principal)).find((c) => c.name === 'SS1 A')!;
      assert.deepEqual({ male: row.male, female: row.female, unknown: row.unknown, total: row.total }, { male: 3, female: 2, unknown: 2, total: 7 });
    });
    await check('classes come in level order, then arm, whatever order they were created in; empty classes are left out', async () => {
      const f = await fixture();
      await f.enrol(f.ss1b.id, 'm'); await f.enrol(f.ss1a.id, 'f'); await f.enrol(f.jss1a.id, 'm');
      assert.deepEqual(by(await populationByClass(f.principal)), ['JSS1 A', 'SS1 A', 'SS1 B']);
    });
    await check('only ACTIVE students count: suspended, withdrawn, expelled, pending and graduated are not in the chart', async () => {
      const f = await fixture();
      await f.enrol(f.ss1a.id, 'm');
      for (const status of ['suspended', 'withdrawn', 'expelled', 'pending_approval', 'graduated']) await f.enrol(f.ss1a.id, 'f', { status });
      const row = (await populationByClass(f.principal))[0]!; assert.equal(row.total, 1); assert.equal(row.female, 0);
    });
    await check('only ACTIVE enrolments count: a transferred or inactive enrolment is not in the chart', async () => {
      const f = await fixture();
      await f.enrol(f.ss1a.id, 'm'); await f.enrol(f.ss1a.id, 'm', { enrolStatus: 'transferred' }); await f.enrol(f.ss1a.id, 'm', { enrolStatus: 'inactive' });
      assert.equal((await populationByClass(f.principal))[0]!.total, 1);
    });
    await check('only the CURRENT session counts: last year\'s enrolments are not in the chart', async () => {
      const f = await fixture();
      await f.enrol(f.ss1a.id, 'm'); await f.enrol(f.ss1a.id, 'm', { sessionId: f.oldSession.id }); await f.enrol(f.jss1a.id, 'f', { sessionId: f.oldSession.id });
      const rows = await populationByClass(f.principal); assert.deepEqual(by(rows), ['SS1 A']); assert.equal(rows[0]!.total, 1);
    });
    await check('no current session, or nobody enrolled, gives an empty chart rather than an error', async () => {
      const f = await fixture(); assert.deepEqual(await populationByClass(f.principal), []);
      await db.update(schema.academicSessions).set({ isCurrent: false }).where(eq(schema.academicSessions.schoolId, f.schoolId));
      await f.enrol(f.ss1a.id, 'm', { sessionId: f.oldSession.id }); assert.deepEqual(await populationByClass(f.principal), []);
    });
    await check('the principal, vice principal and exam officer all see every class', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm'); await f.enrol(f.ss1b.id, 'f'); await f.enrol(f.jss1a.id, 'm');
      for (const who of [f.principal, f.vice, f.officer]) assert.deepEqual(by(await populationByClass(who)), ['JSS1 A', 'SS1 A', 'SS1 B'], who.role);
    });
    await check('a class teacher sees ONLY the class they hold: no other class\'s name or number leaves the query', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm'); await f.enrol(f.ss1a.id, 'f'); await f.enrol(f.ss1b.id, 'm'); await f.enrol(f.jss1a.id, 'm');
      const rows = await populationByClass(f.classTeacher); assert.deepEqual(by(rows), ['SS1 A']); assert.equal(rows[0]!.total, 2);
      assert.ok(!JSON.stringify(rows).includes('SS1 B') && !JSON.stringify(rows).includes('JSS1'));
    });
    await check('a subject teacher, and a teacher with no class, see nothing', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm');
      assert.deepEqual(await populationByClass(f.subjectTeacher), []); assert.deepEqual(await populationByClass(f.headOfNone), []);
    });
    await check('"mine": a principal who also holds a class sees only that class on the Teaching view, but everything on the office view', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm'); await f.enrol(f.ss1b.id, 'f'); await f.enrol(f.jss1a.id, 'm');
      await db.insert(schema.staffAssignments).values({ schoolId: f.schoolId, staffId: f.principal.staffId!, classId: f.ss1b.id, assignmentType: 'class_teacher', status: 'active' } as never);
      assert.deepEqual(by(await populationByClass(f.principal, { mine: true })), ['SS1 B']);
      assert.deepEqual(by(await populationByClass(f.principal)), ['JSS1 A', 'SS1 A', 'SS1 B']);
    });
    await check('"mine" for a principal who holds no class is an empty list, not the whole school', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm');
      assert.deepEqual(await populationByClass(f.principal, { mine: true }), []);
    });
    await check('a student or a parent session sees nothing', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm');
      for (const role of ['student', 'parent'] as const) assert.deepEqual(await populationByClass({ ...f.principal, role, staffId: null }), [], role);
    });
    await check('a class teacher whose assignment was ended no longer sees the class', async () => {
      const f = await fixture(); await f.enrol(f.ss1a.id, 'm');
      await db.update(schema.staffAssignments).set({ status: 'inactive' } as never).where(eq(schema.staffAssignments.staffId, f.classTeacher.staffId!));
      assert.deepEqual(await populationByClass(f.classTeacher), []);
    });
    await check('another school\'s numbers are never mixed in', async () => {
      const f = await fixture(), g = await fixture();
      await f.enrol(f.ss1a.id, 'm'); for (let i = 0; i < 5; i++) await g.enrol(g.ss1a.id, 'f');
      const rows = await populationByClass(f.principal); assert.equal(rows.length, 1); assert.equal(rows[0]!.total, 1); assert.equal(rows[0]!.female, 0);
    });
    await check('the bars add up to the real active enrolment', async () => {
      const f = await fixture();
      for (const [c, g, n] of [[f.ss1a, 'm', 4], [f.ss1a, 'f', 3], [f.ss1b, 'f', 6], [f.jss1a, null, 2]] as const) for (let i = 0; i < n; i++) await f.enrol(c.id, g);
      const rows = await populationByClass(f.principal); assert.equal(rows.reduce((a, r) => a + r.total, 0), 15);
      for (const r of rows) assert.equal(r.total, r.male + r.female + r.unknown);
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
