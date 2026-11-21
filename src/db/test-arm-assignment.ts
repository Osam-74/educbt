/**
 * Splitting a class into arms, against the real database: who may do it, what it refuses, and that nothing is lost.
 * Isolated fixture school, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { assignToArm, armTargets, armSources, armRoster } = await import('@/lib/people/arm-assignment');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture(opts: { capacityB?: number } = {}) {
    const [school] = await db.insert(schema.schools).values({ name: 'Arms', code: 'AR-' + randomUUID() }).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const mk = async (role: 'principal' | 'teacher', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      return { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: login } as Actor;
    };
    const principal = await mk('principal', 'principal'), classTeacher = await mk('teacher', 'ctA'), subjectTeacher = await mk('teacher', 'sub');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [ss1] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1', stage: 'senior' }).returning();
    const [ss2] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS2', stage: 'senior' }).returning();
    const room = async (levelId: number, arm: string | null, name: string, extra: Record<string, unknown> = {}) =>
      (await db.insert(schema.classes).values({ schoolId, levelId, arm, displayName: name, ...extra } as never).returning())[0]!;
    const plain = await room(ss1!.id, null, 'SS1'), armA = await room(ss1!.id, 'A', 'SS1 A'), armB = await room(ss1!.id, 'B', 'SS1 B', { capacity: opts.capacityB ?? 0 });
    const other = await room(ss2!.id, 'A', 'SS2 A'), closed = await room(ss1!.id, 'C', 'SS1 C', { status: 'inactive' });
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staffId!, classId: plain.id, assignmentType: 'class_teacher', status: 'active' } as never);
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staffId!, classId: armA.id, assignmentType: 'class_teacher', status: 'active' } as never);
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: subjectTeacher.staffId!, subjectId: maths!.id, classId: plain.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const students: number[] = [];
    for (let i = 0; i < 6; i++) {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'A' + randomUUID().slice(0, 7), firstName: 'Stu', lastName: 'N' + i } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId: plain.id, sessionId: session!.id, status: 'active' } as never);
      students.push(Number(s!.id));
    }
    return { schoolId, principal, classTeacher, subjectTeacher, session: session!, term: term!, maths: maths!, plain, armA, armB, other, closed, students };
  }
  const classOf = async (studentId: number) => Number((await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, studentId)))[0]!.classId);

  try {
    await check('the principal splits a class: students land in the arm and nobody else moves', async () => {
      const f = await fixture();
      const r = await assignToArm(f.principal, f.students.slice(0, 3), f.armA.id);
      assert.equal(r.success, true); assert.equal((r as { moved: number }).moved, 3); assert.deepEqual((r as { skipped: unknown[] }).skipped, []);
      for (const s of f.students.slice(0, 3)) assert.equal(await classOf(s), Number(f.armA.id));
      for (const s of f.students.slice(3)) assert.equal(await classOf(s), Number(f.plain.id));
    });
    await check('nothing is lost: the same enrolment rows are kept (same ids, same count), only the class changed', async () => {
      const f = await fixture();
      const before = await db.select().from(schema.enrollments).where(eq(schema.enrollments.schoolId, f.schoolId));
      await assignToArm(f.principal, f.students, f.armB.id);
      const after = await db.select().from(schema.enrollments).where(eq(schema.enrollments.schoolId, f.schoolId));
      assert.equal(after.length, before.length); assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
      assert.ok(after.every((r) => r.status === 'active'), 'none marked transferred or inactive');
      assert.equal((await db.select().from(schema.students).where(eq(schema.students.schoolId, f.schoolId))).length, 6, 'no student record touched');
    });
    await check('a student\'s attempts and registrations stay attached to them', async () => {
      const f = await fixture();
      await db.insert(schema.studentSubjects).values({ schoolId: f.schoolId, studentId: f.students[0]!, subjectId: f.maths.id, sessionId: f.session.id, termId: f.term.id } as never);
      await assignToArm(f.principal, [f.students[0]!], f.armA.id);
      assert.equal((await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, f.students[0]!))).length, 1);
    });
    await check('it is not a promotion: no promotion record is written', async () => {
      const f = await fixture(); await assignToArm(f.principal, f.students, f.armA.id);
      const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, f.schoolId));
      assert.ok(logs.every((l) => !String(l.action).includes('promot')));
      assert.equal(logs.filter((l) => l.action === 'student.arm_assigned').length, 6, 'one audit row per student moved');
    });
    await check('a different level is refused and the student stays where they were', async () => {
      const f = await fixture(); const r = await assignToArm(f.principal, [f.students[0]!], f.other.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.match(r.skipped[0]!.reason, /different level/); assert.equal(await classOf(f.students[0]!), Number(f.plain.id));
    });
    await check('an inactive class is refused', async () => {
      const f = await fixture(); const r = await assignToArm(f.principal, [f.students[0]!], f.closed.id) as { skipped: Array<{ reason: string }> };
      assert.match(r.skipped[0]!.reason, /not active/);
    });
    await check('a student already in that class is refused, not "moved" again', async () => {
      const f = await fixture(); await assignToArm(f.principal, [f.students[0]!], f.armA.id);
      const r = await assignToArm(f.principal, [f.students[0]!], f.armA.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.match(r.skipped[0]!.reason, /Already in that class/);
    });
    await check('a student with scores recorded this term is skipped, the others still move', async () => {
      const f = await fixture();
      await db.insert(schema.assessmentScores).values({ schoolId: f.schoolId, studentId: f.students[1]!, subjectId: f.maths.id, sessionId: f.session.id, termId: f.term.id, componentKey: 'ca1', score: '10', maxScore: '20' } as never);
      const r = await assignToArm(f.principal, f.students.slice(0, 3), f.armA.id) as { moved: number; skipped: Array<{ studentId: number; reason: string }> };
      assert.equal(r.moved, 2); assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0]!.studentId, f.students[1]);
      assert.match(r.skipped[0]!.reason, /Already has 1 score recorded this term/); assert.equal(await classOf(f.students[1]!), Number(f.plain.id));
    });
    await check('a score from an EARLIER term does not block the split', async () => {
      const f = await fixture();
      const [oldTerm] = await db.insert(schema.terms).values({ schoolId: f.schoolId, sessionId: f.session.id, title: 'Old Term', position: 2 }).returning();
      await db.insert(schema.assessmentScores).values({ schoolId: f.schoolId, studentId: f.students[0]!, subjectId: f.maths.id, sessionId: f.session.id, termId: oldTerm!.id, componentKey: 'ca1', score: '10', maxScore: '20' } as never);
      assert.equal((await assignToArm(f.principal, [f.students[0]!], f.armA.id) as { moved: number }).moved, 1);
    });
    await check('compiled results this term block the move, with the stronger reason', async () => {
      const f = await fixture();
      await db.insert(schema.subjectResults).values({ schoolId: f.schoolId, studentId: f.students[0]!, subjectId: f.maths.id, sessionId: f.session.id, termId: f.term.id } as never);
      await db.insert(schema.assessmentScores).values({ schoolId: f.schoolId, studentId: f.students[0]!, subjectId: f.maths.id, sessionId: f.session.id, termId: f.term.id, componentKey: 'ca1', score: '10', maxScore: '20' } as never);
      const r = await assignToArm(f.principal, [f.students[0]!], f.armA.id) as { skipped: Array<{ reason: string }> };
      assert.match(r.skipped[0]!.reason, /results compiled this term/);
    });
    await check('a student not enrolled this session is skipped with a clear reason; an unknown id is "not found"', async () => {
      const f = await fixture();
      const [loose] = await db.insert(schema.students).values({ schoolId: f.schoolId, admissionNumber: 'L' + randomUUID().slice(0, 7), firstName: 'Loose', lastName: 'End' } as never).returning();
      const r = await assignToArm(f.principal, [Number(loose!.id), 987654321], f.armA.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.deepEqual(r.skipped.map((s) => s.reason), ['Not enrolled in the current session.', 'Student not found.']);
    });
    await check('a student whose enrolment is no longer active (transferred) is skipped and their record is left alone', async () => {
      const f = await fixture();
      await db.update(schema.enrollments).set({ status: 'transferred' }).where(eq(schema.enrollments.studentId, f.students[0]!));
      const r = await assignToArm(f.principal, [f.students[0]!], f.armA.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.match(r.skipped[0]!.reason, /Not enrolled in the current session/);
      const row = (await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, f.students[0]!)))[0]!;
      assert.equal(Number(row.classId), Number(f.plain.id)); assert.equal(row.status, 'transferred');
    });
    await check('a full arm takes students only up to its seats; the rest are skipped, nobody is over-subscribed', async () => {
      const f = await fixture({ capacityB: 2 });
      const r = await assignToArm(f.principal, f.students.slice(0, 4), f.armB.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 2); assert.equal(r.skipped.length, 2); assert.ok(r.skipped.every((s) => /capacity/.test(s.reason)));
      assert.equal((await db.select().from(schema.enrollments).where(eq(schema.enrollments.classId, f.armB.id))).length, 2);
    });
    await check('a class teacher can split THEIR class into THEIR arm', async () => {
      const f = await fixture(); const r = await assignToArm(f.classTeacher, f.students.slice(0, 2), f.armA.id) as { moved: number };
      assert.equal(r.moved, 2);
    });
    await check('a class teacher cannot move students into an arm they do not manage', async () => {
      const f = await fixture(); const r = await assignToArm(f.classTeacher, [f.students[0]!], f.armB.id);
      assert.equal(r.success, false); assert.match((r as { error: string }).error, /cannot move students into that class/); assert.equal(await classOf(f.students[0]!), Number(f.plain.id));
    });
    await check('a class teacher cannot move students out of a class they do not manage', async () => {
      const f = await fixture();
      const [s] = await db.insert(schema.students).values({ schoolId: f.schoolId, admissionNumber: 'X' + randomUUID().slice(0, 7), firstName: 'Else', lastName: 'Where' } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId: f.schoolId, studentId: s!.id, classId: f.armB.id, sessionId: f.session.id, status: 'active' } as never);
      const r = await assignToArm(f.classTeacher, [Number(s!.id)], f.armA.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.match(r.skipped[0]!.reason, /Not in a class you manage/);
    });
    await check('a subject teacher (no class of their own) cannot split anything', async () => {
      const f = await fixture(); const r = await assignToArm(f.subjectTeacher, [f.students[0]!], f.armA.id);
      assert.equal(r.success, false); assert.match((r as { error: string }).error, /Only a principal/);
    });
    await check('the choice of arms offered follows the same scope: all for the principal, only own for a class teacher, none for a subject teacher', async () => {
      const f = await fixture();
      assert.deepEqual((await armTargets(f.principal, f.plain.id)).map((t) => t.name), ['SS1 A', 'SS1 B'], 'same level, active only, not itself, not SS2, not the inactive one');
      assert.deepEqual((await armTargets(f.classTeacher, f.plain.id)).map((t) => t.name), ['SS1 A']);
      assert.deepEqual(await armTargets(f.subjectTeacher, f.plain.id), []);
      assert.deepEqual(await armTargets(f.classTeacher, f.armB.id), [], 'a class they do not manage offers nothing');
    });
    await check('the classes offered to split: the principal sees every class that has students and an arm to go to', async () => {
      const f = await fixture();
      const names = (await armSources(f.principal)).map((c) => c.name);
      assert.ok(names.includes('SS1'), 'the class with students'); assert.ok(!names.includes('SS1 A'), 'empty arms are not offered'); assert.ok(!names.includes('SS2 A'), 'a level with no other arm has nowhere to split into');
    });
    await check('a class teacher is offered only their own classes; a subject teacher none', async () => {
      const f = await fixture();
      assert.deepEqual((await armSources(f.classTeacher)).map((c) => c.name), ['SS1']);
      assert.deepEqual(await armSources(f.subjectTeacher), []);
    });
    await check('the roster of a class lists its active students, and only for someone allowed to split it', async () => {
      const f = await fixture();
      assert.equal((await armRoster(f.principal, f.plain.id)).length, 6);
      assert.equal((await armRoster(f.classTeacher, f.plain.id)).length, 6);
      assert.deepEqual(await armRoster(f.subjectTeacher, f.plain.id), []);
      assert.deepEqual(await armRoster(f.classTeacher, f.armB.id), [], 'a class they do not hold');
    });
    await check('students already moved no longer appear in the old class roster, and a transferred one never does', async () => {
      const f = await fixture();
      await assignToArm(f.principal, f.students.slice(0, 2), f.armA.id);
      await db.update(schema.enrollments).set({ status: 'transferred' }).where(eq(schema.enrollments.studentId, f.students[5]!));
      assert.equal((await armRoster(f.principal, f.plain.id)).length, 3);
      assert.equal((await armRoster(f.principal, f.armA.id)).length, 2);
    });
    await check('nothing selected, or too many at once, is refused with a message', async () => {
      const f = await fixture();
      assert.match((await assignToArm(f.principal, [], f.armA.id) as { error: string }).error, /Tick at least one/);
      assert.match((await assignToArm(f.principal, Array.from({ length: 501 }, (_, i) => i + 1), f.armA.id) as { error: string }).error, /at most 500/);
    });
    await check('a database error part way rolls the WHOLE batch back (all or nothing)', async () => {
      const f = await fixture();
      const victim = f.students[2]!;
      // The audit insert for the THIRD student fails. The first two have already been moved inside the transaction.
      await owner.unsafe(`CREATE OR REPLACE FUNCTION arm_test_boom() RETURNS trigger AS $$ BEGIN IF NEW.action = 'student.arm_assigned' AND NEW.after->>'classId' = '${f.armA.id}' AND NEW.before->>'classId' = '${f.plain.id}' AND (SELECT count(*) FROM audit_log WHERE school_id = NEW.school_id AND action = 'student.arm_assigned') >= 2 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await owner.unsafe(`CREATE TRIGGER arm_test_boom_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION arm_test_boom()`);
      try {
        await assert.rejects(assignToArm(f.principal, f.students.slice(0, 4), f.armA.id), /boom/);
      } finally {
        await owner.unsafe('DROP TRIGGER IF EXISTS arm_test_boom_t ON audit_log'); await owner.unsafe('DROP FUNCTION IF EXISTS arm_test_boom()');
      }
      for (const s of f.students) assert.equal(await classOf(s), Number(f.plain.id), 'nobody moved, not even the first two');
      assert.equal((await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, f.schoolId), eq(schema.auditLog.action, 'student.arm_assigned')))).length, 0);
      assert.ok(victim);
    });
    await check('another school\'s student and class are never touched', async () => {
      const f = await fixture(), g = await fixture();
      const r = await assignToArm(f.principal, [g.students[0]!], f.armA.id) as { moved: number; skipped: Array<{ reason: string }> };
      assert.equal(r.moved, 0); assert.equal(await classOf(g.students[0]!), Number(g.plain.id));
      const r2 = await assignToArm(f.principal, [f.students[0]!], g.armA.id); assert.equal(r2.success, false);
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
