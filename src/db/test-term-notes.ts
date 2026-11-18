/** Class teacher's remark + attendance screen service. Disposable localhost *_ca_test database only; service calls use educbt_app. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, asc, eq } from 'drizzle-orm';
import { defaultConfig } from '@/lib/settings/validation';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, forSchool, client } = await import('@/db');
  const service = await import('@/lib/settings/service');
  const { classTermSheet, saveTermNotes, validAttendance, reportExtras } = await import('@/lib/settings/remarks');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); count++; console.log('PASS  ' + name); }

  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Notes school', code: 'NOTE-' + randomUUID(), settings: structuredClone(defaultConfig) as never }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const users = await db.insert(schema.users).values((['principal', 'teacher', 'teacher'] as const).map((role, i) => ({
      schoolId, role, loginId: role + i + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }))).returning();
    const actors: Actor[] = [];
    for (const [i, user] of users.entries()) {
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user.id, role: user.role, staffNumber: 'S' + i, firstName: 'Ada', lastName: user.role + i }).returning();
      actors.push({ schoolId, userId: user.id, role: user.role, loginId: user.loginId, staffId: staff!.id, studentId: null });
    }
    const [principal, classTeacher, otherTeacher] = actors as [Actor, Actor, Actor];
    const session = await service.createSession(principal, { title: '2026/2027', startsOn: '2026-09-01', endsOn: '2027-07-31', makeCurrent: true });
    const terms = await db.select().from(schema.terms).where(eq(schema.terms.sessionId, session.id)).orderBy(asc(schema.terms.position));
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [classroom] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'A', displayName: 'JSS1 A' }).returning();
    const [otherRoom] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'B', displayName: 'JSS1 B' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staffId!, classId: classroom!.id, assignmentType: 'class_teacher' });
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: otherTeacher.staffId!, classId: otherRoom!.id, assignmentType: 'class_teacher' });
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MATH', name: 'Mathematics' }).returning();
    const mk = async (n: string, last: string, room: typeof classroom) => {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: n, firstName: 'Pupil' + n, lastName: last }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, sessionId: session.id, classId: room!.id });
      await db.insert(schema.subjectResults).values({ schoolId, studentId: s!.id, subjectId: subject!.id, sessionId: session.id, termId: terms[0]!.id, complete: true, total: '50', state: 'compiled', gradingScaleId: 'school-' + schoolId, gradingScaleVersion: 1 });
      return s!;
    };
    const mine = await mk('001', 'Zed', classroom), mine2 = await mk('002', 'Abel', classroom), theirs = await mk('003', 'Yusuf', otherRoom);
    return { schoolId, principal, classTeacher, otherTeacher, session, term: terms[0]!, classroom: classroom!, mine, mine2, theirs, subject: subject! };
  }

  try {
    const a = await fixture(), b = await fixture();
    const scope = (f: typeof a, studentId: number) => ({ studentId, sessionId: f.session.id, termId: f.term.id });
    const summary = async (studentId: number) => (await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, studentId)))[0];
    const remarkRow = async (studentId: number) => (await db.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.studentId, studentId), eq(schema.reportRemarks.role, 'class_teacher'))))[0];

    await check('attendance must be whole numbers, not above the days open, and no more than 366', () => {
      assert.deepEqual(validAttendance(58, 60), { present: 58, total: 60 });
      for (const [p, t] of [[61, 60], [-1, 60], [1.5, 60], [5, 400], ['x', 60], [5, NaN]] as const) assert.throws(() => validAttendance(p, t), /days|whole/i);
    });
    await check('class teacher sees only the pupils of their own class, ordered by surname', async () => {
      const sheet = await classTermSheet(a.classTeacher, null);
      assert.equal(sheet.chosen?.id, a.classroom.id);
      assert.deepEqual(sheet.rows.map(r => r.studentId), [a.mine2.id, a.mine.id]);
      assert.ok(!sheet.rows.some(r => r.studentId === a.theirs.id), 'a pupil of another class must not appear');
    });
    await check('a teacher cannot open another class by passing its id', async () => {
      const sheet = await classTermSheet(a.classTeacher, (await db.select().from(schema.classes).where(eq(schema.classes.displayName, 'JSS1 B')).then(r => r.find(c => c.schoolId === a.schoolId)!)).id);
      assert.equal(sheet.chosen?.id, a.classroom.id); assert.ok(!sheet.rows.some(r => r.studentId === a.theirs.id));
    });
    await check('the principal has no class of their own here', async () => assert.equal((await classTermSheet(a.principal, null)).rows.length, 0));
    await check('remark and attendance save together and appear on the sheet and on the report card', async () => {
      await saveTermNotes(a.classTeacher, { ...scope(a, a.mine.id), remark: 'A hard-working pupil.', present: 56, total: 60 });
      const row = (await classTermSheet(a.classTeacher, null)).rows.find(r => r.studentId === a.mine.id)!;
      assert.equal(row.remark, 'A hard-working pupil.'); assert.equal(row.source, 'manual'); assert.equal(row.present, 56); assert.equal(row.total, 60);
      const extras = await forSchool(a.schoolId, tx => reportExtras(tx, a.schoolId, a.mine.id, a.session.id, a.term.id, a.classroom.id));
      assert.equal(extras.remarks.class_teacher, 'A hard-working pupil.'); assert.deepEqual(extras.attendance, { present: 56, total: 60 });
    });
    await check('saving again updates the same rows instead of adding duplicates', async () => {
      await saveTermNotes(a.classTeacher, { ...scope(a, a.mine.id), remark: 'Improving.', present: 58, total: 60 });
      assert.equal((await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, a.mine.id))).length, 1);
      assert.equal((await summary(a.mine.id))!.daysPresent, 58); assert.equal((await remarkRow(a.mine.id))!.remark, 'Improving.');
    });
    await check('ATOMIC: impossible attendance saves neither the remark nor the days', async () => {
      await assert.rejects(saveTermNotes(a.classTeacher, { ...scope(a, a.mine2.id), remark: 'Should not stick.', present: 70, total: 60 }), /more than/);
      assert.equal(await remarkRow(a.mine2.id), undefined); assert.equal(await summary(a.mine2.id), undefined);
    });
    await check('ATOMIC: a refused save (foreign pupil) leaves no attendance behind either', async () => {
      await assert.rejects(saveTermNotes(a.classTeacher, { ...scope(a, a.theirs.id), remark: 'Not mine.', present: 10, total: 10 }), /assigned class/);
      assert.equal(await summary(a.theirs.id), undefined); assert.equal(await remarkRow(a.theirs.id), undefined);
    });
    await check('another school\'s pupil cannot be written to', async () => {
      await assert.rejects(saveTermNotes(a.classTeacher, { ...scope(a, b.mine.id), remark: 'Cross school.', present: 1, total: 1 }));
      assert.equal(await summary(b.mine.id), undefined); assert.equal(await remarkRow(b.mine.id), undefined);
    });
    await check('a teacher who is not this class\'s teacher cannot write to it', async () => {
      await assert.rejects(saveTermNotes(a.otherTeacher, { ...scope(a, a.mine.id), remark: 'Not my class.', present: 1, total: 1 }), /assigned class/);
      assert.equal((await summary(a.mine.id))!.daysPresent, 58);
    });
    await check('the principal cannot write a class teacher\'s remark', () => assert.rejects(saveTermNotes(a.principal, { ...scope(a, a.mine.id), remark: 'x', present: 1, total: 1 })));
    await check('once results are under review the sheet reports it locked and a save is refused with nothing changed', async () => {
      await db.update(schema.subjectResults).set({ state: 'reviewed' }).where(eq(schema.subjectResults.studentId, a.mine.id));
      assert.equal((await classTermSheet(a.classTeacher, null)).rows.find(r => r.studentId === a.mine.id)!.locked, true);
      await assert.rejects(saveTermNotes(a.classTeacher, { ...scope(a, a.mine.id), remark: 'Too late.', present: 3, total: 3 }), /before review/);
      assert.equal((await summary(a.mine.id))!.daysPresent, 58); assert.equal((await remarkRow(a.mine.id))!.remark, 'Improving.');
    });
    await check('an over-long remark is refused whole', () => assert.rejects(saveTermNotes(a.classTeacher, { ...scope(a, a.mine2.id), remark: 'x'.repeat(501), present: 1, total: 1 }), /500/));
    await check('an imported remark and attendance show until the teacher writes their own', async () => {
      await db.insert(schema.termSummaries).values({ schoolId: a.schoolId, studentId: a.mine2.id, sessionId: a.session.id, termId: a.term.id, classId: a.classroom.id, classTeacherRemark: 'From the old site.', daysPresent: 40, daysTotal: 45 });
      const row = (await classTermSheet(a.classTeacher, null)).rows.find(r => r.studentId === a.mine2.id)!;
      assert.equal(row.remark, 'From the old site.'); assert.equal(row.source, 'imported'); assert.equal(row.present, 40);
      await saveTermNotes(a.classTeacher, { ...scope(a, a.mine2.id), remark: 'Now written here.', present: 41, total: 45 });
      const after = (await classTermSheet(a.classTeacher, null)).rows.find(r => r.studentId === a.mine2.id)!;
      assert.equal(after.remark, 'Now written here.'); assert.equal(after.source, 'manual'); assert.equal(after.present, 41);
    });
    await check('every save is written to the audit log', async () => {
      const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, a.schoolId), eq(schema.auditLog.action, 'settings.attendance')));
      assert.ok(rows.length >= 3, 'attendance changes are audited, found ' + rows.length);
    });
    console.log(`${count} term notes checks passed.`);
  } finally {
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner.end(); await client.end();
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
