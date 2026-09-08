/**
 * Isolated, rerun-safe CA integration checks. Run with the app-role and owner URLs
 * pointing at a disposable LOCAL database; never at production.
 * npx tsx src/db/test-ca.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('CA integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema, forSchool, client: appClient } = await import('@/db');
  const { enterScore } = await import('@/lib/exam/results');
  const { caOptions, caRoster } = await import('@/lib/ca/queries');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const app = postgres(process.env.DATABASE_URL_APP!, { max: 1 });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const settings = { assessmentComponents: [
    { key: 'ca1', label: 'CA One', maxScore: 20, isExam: false },
    { key: 'ca2', label: 'CA Two', maxScore: 10, isExam: false },
    { key: 'exam', label: 'Exam', maxScore: 70, isExam: true },
  ] };
  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'CA test', code: 'CA-' + randomUUID(), settings }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const sessions = await db.insert(schema.academicSessions).values([{ schoolId, title: '2026' }, { schoolId, title: '2027' }]).returning();
    const terms = await db.insert(schema.terms).values([
      { schoolId, sessionId: sessions[0]!.id, title: 'First', position: 1 },
      { schoolId, sessionId: sessions[0]!.id, title: 'Second', position: 2 },
      { schoolId, sessionId: sessions[1]!.id, title: 'First', position: 1 },
    ]).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: level!.id, displayName: 'JSS1 A', arm: 'A' },
      { schoolId, levelId: level!.id, displayName: 'JSS1 B', arm: 'B' },
    ]).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Maths', code: 'MTH' }, { schoolId, name: 'English', code: 'ENG' },
    ]).returning();
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'teacher', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Teacher', lastName: 'One' }).returning();
    const assignments = await db.insert(schema.staffAssignments).values([
      { schoolId, staffId: staff!.id, classId: classes[0]!.id, subjectId: subjects[0]!.id },
      { schoolId, staffId: staff!.id, classId: classes[1]!.id, subjectId: subjects[1]!.id },
    ]).returning();
    const students = await db.insert(schema.students).values([
      { schoolId, admissionNumber: '1', firstName: 'Student', lastName: 'One' },
      { schoolId, admissionNumber: '2', firstName: 'Student', lastName: 'Two' },
      { schoolId, admissionNumber: '3', firstName: 'Unregistered', lastName: 'Three' },
    ]).returning();
    for (const session of sessions) for (const student of students) {
      await db.insert(schema.enrollments).values({ schoolId, studentId: student.id, sessionId: session.id, classId: classes[0]!.id });
      if (student.id !== students[2]!.id) for (const subject of subjects)
        await db.insert(schema.studentSubjects).values({ schoolId, studentId: student.id, sessionId: session.id, subjectId: subject.id });
    }
    const actor: Actor = { schoolId, userId: user!.id, staffId: staff!.id, role: 'teacher', loginId: 'teacher', studentId: null };
    return { schoolId, sessions, terms, classes, subjects, students, assignments, staff: staff!, actor };
  }
  try {
    await check('runtime role cannot bypass RLS', async () => {
      const [r] = await app`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`;
      assert.equal(r!.rolsuper, false); assert.equal(r!.rolbypassrls, false);
    });
    const a = await fixture(); const b = await fixture();
    const input = { classId: a.classes[0]!.id, studentId: a.students[0]!.id, subjectId: a.subjects[0]!.id,
      sessionId: a.sessions[0]!.id, termId: a.terms[0]!.id, componentKey: 'ca1', score: 0, maxScore: 20 };
    const scope = { classId: input.classId, subjectId: input.subjectId, sessionId: input.sessionId, termId: input.termId, componentKey: input.componentKey };
    const deny = async (actor: Actor, change = {}) => assert.equal((await enterScore(actor, { ...input, ...change })).ok, false);
    await check('teacher sees exact assigned pairs only', async () => assert.equal((await caOptions(a.actor))!.pairs.length, 2));
    await check('roster excludes unregistered students', async () => assert.equal((await caRoster(a.actor, scope))!.rows.length, 2));
    await check('new scores are missing, not zero', async () => assert.equal((await caRoster(a.actor, scope))!.rows[0]!.score, null));
    await check('zero saves successfully', async () => assert.equal((await enterScore(a.actor, input)).ok, true));
    await check('zero reloads as an entered score', async () => assert.equal(Number((await caRoster(a.actor, scope))!.rows[0]!.score), 0));
    await check('repeat saves update one full-scope row', async () => {
      assert((await enterScore(a.actor, { ...input, score: 12.34 })).ok);
      assert((await enterScore(a.actor, { ...input, score: 12.34 })).ok);
      const rows = await db.select().from(schema.assessmentScores).where(eq(schema.assessmentScores.schoolId, a.schoolId));
      assert.equal(rows.length, 1); assert.equal(rows[0]!.score, '12.34'); assert.equal(rows[0]!.enteredBy, a.actor.userId);
    });
    for (const role of ['student', 'parent', 'platform_admin', 'unknown']) {
      await check(role + ' cannot read CA options', async () => assert.equal(await caOptions({ ...a.actor, role }), null));
      await check(role + ' cannot write scores', () => deny({ ...a.actor, role }));
    }
    await check('teacher without staff record rejected', () => deny({ ...a.actor, staffId: null }));
    await check('forged staff identity rejected', () => deny({ ...a.actor, userId: b.actor.userId }));
    await check('separate class and subject assignments cannot be combined', () => deny(a.actor, { subjectId: a.subjects[1]!.id }));
    await check('unassigned read rejected before roster fetch', async () => assert.equal(await caRoster(a.actor, { ...scope, subjectId: a.subjects[1]!.id }), null));
    await check('unregistered student rejected', () => deny(a.actor, { studentId: a.students[2]!.id }));
    await check('wrong selected class rejected', () => deny(a.actor, { classId: a.classes[1]!.id }));
    await check('session and term mismatch rejected', () => deny(a.actor, { sessionId: a.sessions[1]!.id }));
    await check('foreign student rejected', () => deny(a.actor, { studentId: b.students[0]!.id }));
    await check('foreign subject rejected', () => deny(a.actor, { subjectId: b.subjects[0]!.id }));
    await check('foreign school scope cannot be read', async () => assert.equal(await caRoster(b.actor, scope), null));
    await check('forged component rejected', () => deny(a.actor, { componentKey: 'madeup' }));
    await check('exam component rejected', () => deny(a.actor, { componentKey: 'exam', maxScore: 70 }));
    await check('forged maximum rejected', () => deny(a.actor, { maxScore: 100 }));
    await check('over maximum rejected', () => deny(a.actor, { score: 20.01 }));
    await check('non-finite score rejected', () => deny(a.actor, { score: NaN }));
    await check('precision loss rejected', () => deny(a.actor, { score: 1.234 }));
    for (const status of ['suspended', 'left'] as const) {
      await db.update(schema.staff).set({ status }).where(eq(schema.staff.id, a.staff.id));
      await check(status + ' staff cannot save', () => deny(a.actor));
    }
    await db.update(schema.staff).set({ status: 'active' }).where(eq(schema.staff.id, a.staff.id));
    await db.update(schema.staffAssignments).set({ status: 'inactive' }).where(eq(schema.staffAssignments.id, a.assignments[0]!.id));
    await check('revoked assignment rejected on save', () => deny(a.actor));
    await db.update(schema.staffAssignments).set({ status: 'active' }).where(eq(schema.staffAssignments.id, a.assignments[0]!.id));
    await db.update(schema.students).set({ status: 'suspended' }).where(eq(schema.students.id, input.studentId));
    await check('suspended student rejected', () => deny(a.actor));
    await db.update(schema.students).set({ status: 'active' }).where(eq(schema.students.id, input.studentId));
    await db.update(schema.enrollments).set({ status: 'inactive' }).where(and(eq(schema.enrollments.studentId, input.studentId), eq(schema.enrollments.sessionId, input.sessionId)));
    await check('inactive enrollment rejected', () => deny(a.actor));
    await db.update(schema.enrollments).set({ status: 'active' }).where(and(eq(schema.enrollments.studentId, input.studentId), eq(schema.enrollments.sessionId, input.sessionId)));
    await db.update(schema.schools).set({ settings: {} }).where(eq(schema.schools.id, a.schoolId));
    await check('missing configuration rejects writes', () => deny(a.actor));
    await db.update(schema.schools).set({ settings }).where(eq(schema.schools.id, a.schoolId));
    for (const role of ['principal', 'vice_principal', 'exam_officer']) {
      await check(role + ' has school-wide CA access', async () => assert((await enterScore({ ...a.actor, role, staffId: null }, { ...input, subjectId: a.subjects[1]!.id })).ok));
    }
    await check('second student is a separate score', async () => assert((await enterScore(a.actor, { ...input, studentId: a.students[1]!.id, score: 4 })).ok));
    await check('second component is a separate score', async () => assert((await enterScore(a.actor, { ...input, componentKey: 'ca2', maxScore: 10, score: 5 })).ok));
    await check('second term is a separate score', async () => assert((await enterScore(a.actor, { ...input, termId: a.terms[1]!.id, score: 6 })).ok));
    await check('second session is a separate score', async () => assert((await enterScore(a.actor, { ...input, sessionId: a.sessions[1]!.id, termId: a.terms[2]!.id, score: 7 })).ok));
    await check('other school can save independently', async () => assert((await enterScore(b.actor, { ...input, classId: b.classes[0]!.id, studentId: b.students[0]!.id, subjectId: b.subjects[0]!.id, sessionId: b.sessions[0]!.id, termId: b.terms[0]!.id, score: 8 })).ok));
    await check('all score dimensions remain isolated', async () => {
      const rows = await db.select().from(schema.assessmentScores).where(eq(schema.assessmentScores.schoolId, a.schoolId));
      assert.equal(rows.length, 6);
      const sheet = await caRoster(a.actor, scope);
      assert.deepEqual(sheet!.rows.map(r => Number(r.score)), [12.34, 4]);
    });
    const [result] = await db.insert(schema.subjectResults).values({ schoolId: a.schoolId, studentId: input.studentId,
      subjectId: input.subjectId, sessionId: input.sessionId, termId: input.termId, state: 'compiled', complete: true }).returning();
    await check('editing compiled result invalidates compilation', async () => {
      assert((await enterScore(a.actor, { ...input, score: 10 })).ok);
      const [r] = await db.select().from(schema.subjectResults).where(eq(schema.subjectResults.id, result!.id));
      assert.equal(r!.state, 'draft'); assert.equal(r!.complete, false);
    });
    for (const state of ['reviewed', 'published', 'locked'] as const) {
      await db.update(schema.subjectResults).set({ state, published: state !== 'reviewed' }).where(eq(schema.subjectResults.id, result!.id));
      await check(state + ' result rejects edits', () => deny(a.actor));
      await check(state + ' result is read-only in roster', async () => assert.equal((await caRoster(a.actor, scope))!.rows[0]!.editable, false));
    }
    await check('locked result does not block another session', async () => assert((await enterScore(a.actor, { ...input, sessionId: a.sessions[1]!.id, termId: a.terms[2]!.id })).ok));
    await check('concurrent publication blocks a waiting CA save', async () => {
      await db.update(schema.subjectResults).set({ state: 'compiled', published: false }).where(eq(schema.subjectResults.id, result!.id));
      let saving: ReturnType<typeof enterScore> | undefined;
      await owner.begin(async held => {
        const key = ['educbt-results', a.schoolId, input.sessionId, input.termId].join(':');
        await held`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        saving = enterScore(a.actor, { ...input, score: 15 });
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [locks] = await app`select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting`;
          if (locks!.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(waiting, 'CA save must wait for the term lifecycle lock');
        await held`update subject_results set state='published', published=true where id=${result!.id}`;
      });
      assert.equal((await saving!).ok, false);
    });
    await db.update(schema.subjectResults).set({ state: 'draft', published: true }).where(eq(schema.subjectResults.id, result!.id));
    await check('inconsistent published flag fails closed', () => deny(a.actor));
    await check('RLS hides foreign scores even without a school filter', async () => {
      const rows = await forSchool(b.schoolId, tx => tx.select().from(schema.assessmentScores));
      assert.equal(rows.length, 1); assert(rows.every(r => r.schoolId === b.schoolId));
    });
    await check('RLS rejects a foreign-school insert', async () => {
      await assert.rejects(forSchool(a.schoolId, tx => tx.insert(schema.assessmentScores).values({
        schoolId: b.schoolId, studentId: input.studentId, subjectId: input.subjectId,
        sessionId: input.sessionId, termId: input.termId, componentKey: 'ca1', score: '1', maxScore: '20',
      })));
    });
    await check('unscoped app connection sees zero scores', async () => assert.equal((await app`select * from assessment_scores`).length, 0));
    if (process.env.CA_TEST_HTTP_URL) {
      const base = new URL(process.env.CA_TEST_HTTP_URL);
      if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('HTTP tests must target localhost.');
      const token = randomUUID() + randomUUID();
      const { createHash } = await import('node:crypto');
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: a.actor.userId, expiresAt: new Date(Date.now() + 60000) });
      const cookie = 'educbt.session=' + token;
      const url = new URL('/portal/ca', base);
      url.search = new URLSearchParams({ pair: input.classId + ':' + input.subjectId, termId: String(input.termId), componentKey: input.componentKey }).toString();
      await check('HTTP unauthenticated route redirects to sign-in', async () => {
        const response = await fetch(url, { redirect: 'manual' });
        assert.equal(response.status, 307); assert(response.headers.get('location')?.includes('/sign-in'));
      });
      await check('HTTP score sheet renders the selected context', async () => {
        const response = await fetch(url, { headers: { cookie } });
        assert.equal(response.status, 200);
        const html = await response.text(); assert(html.includes('CA score entry')); assert(html.includes('CA One'));
        assert(html.includes('Maths')); assert(!html.includes('Unregistered'));
      });
      await check('HTTP closed result renders read only', async () => {
        const html = await (await fetch(url, { headers: { cookie } })).text();
        assert(html.includes('read only')); assert(html.includes('Save score'));
      });
      await check('HTTP forged assignment does not expose score forms', async () => {
        const bad = new URL(url); bad.searchParams.set('pair', input.classId + ':' + a.subjects[1]!.id);
        const html = await (await fetch(bad, { headers: { cookie } })).text();
        assert(html.includes('This score sheet is unavailable')); assert(!html.includes('Save score'));
      });
      await db.update(schema.schools).set({ settings: {} }).where(eq(schema.schools.id, a.schoolId));
      await check('HTTP missing configuration shows setup guidance', async () => {
        const html = await (await fetch(new URL('/portal/ca', base), { headers: { cookie } })).text();
        assert(html.includes('CA components are not configured')); assert(!html.includes('Save score'));
      });
    }
    console.log(count + ' PASS / 0 FAIL');
  } finally {
    for (const schoolId of schoolIds) {
      // These tables deliberately have no cascading school FK.
      await db.delete(schema.assessmentScores).where(eq(schema.assessmentScores.schoolId, schoolId));
      await db.delete(schema.subjectResults).where(eq(schema.subjectResults.schoolId, schoolId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.schoolId, schoolId));
      await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    }
    await owner.end(); await app.end(); await appClient.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
