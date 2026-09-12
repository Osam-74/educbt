/**
 * Role dashboard integration checks (Principal / VP / Teacher / Parent).
 * Run with the app-role and owner URLs pointing at a disposable LOCAL
 * database; never at production.
 *   npx tsx src/db/test-dashboards.ts
 *
 * Legacy reference: templates/portal/school/index.php (office dashboard),
 * templates/portal/teacher/index.php (teaching surface),
 * templates/portal/guardian/index.php (children), school/activity.php (log).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Dashboard integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema, forSchool } = await import('@/db');
  const { schoolDashboard, activityPage, canViewActivity, ACTIVITY_PER_PAGE } = await import('@/lib/portal-dashboard');
  const { teacherDashboard } = await import('@/lib/teacher-dashboard');
  const { guardianChildren } = await import('@/lib/results/family');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };

  async function fixture() {
    const code = 'D' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Dash test', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' },
      { schoolId, levelId: level!.id, displayName: 'SS1 B', arm: 'B' },
    ]).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Maths', code: 'MTH', isCompulsory: true },
      { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
    ]).returning();

    const user = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'parent' | 'student', tag = '') => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
      return u!;
    };
    const principalUser = await user('principal');
    await db.insert(schema.staff).values({ schoolId, userId: principalUser.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal', status: 'active' });
    const vpUser = await user('vice_principal');
    await db.insert(schema.staff).values({ schoolId, userId: vpUser.id, role: 'vice_principal', staffNumber: 'P1', firstName: 'Vee', lastName: 'Deputy', status: 'active' });
    const officerUser = await user('exam_officer');
    await db.insert(schema.staff).values({ schoolId, userId: officerUser.id, role: 'exam_officer', staffNumber: 'P2', firstName: 'Ex', lastName: 'Officer', status: 'active' });

    const teacherUser = await user('teacher', 'a');
    const [teacher] = await db.insert(schema.staff).values({ schoolId, userId: teacherUser.id, role: 'teacher', staffNumber: 'T0', firstName: 'Folake', lastName: 'Adeyemi', status: 'active' }).returning();
    const otherUser = await user('teacher', 'b');
    const [otherTeacher] = await db.insert(schema.staff).values({ schoolId, userId: otherUser.id, role: 'teacher', staffNumber: 'T1', firstName: 'Other', lastName: 'Teacher', status: 'active' }).returning();

    // Teacher A heads SS1 A and teaches Maths in SS1 A + Biology in SS1 B.
    // Teacher B teaches Biology in SS1 A only — the isolation case.
    await db.insert(schema.staffAssignments).values([
      { schoolId, staffId: teacher!.id, classId: classes[0]!.id, subjectId: null, assignmentType: 'class_teacher', status: 'active' },
      { schoolId, staffId: teacher!.id, classId: classes[0]!.id, subjectId: subjects[0]!.id, assignmentType: 'subject_teacher', status: 'active' },
      { schoolId, staffId: teacher!.id, classId: classes[1]!.id, subjectId: subjects[1]!.id, assignmentType: 'subject_teacher', status: 'active' },
      { schoolId, staffId: otherTeacher!.id, classId: classes[0]!.id, subjectId: subjects[1]!.id, assignmentType: 'subject_teacher', status: 'active' },
    ]);

    const student = async (admission: string, status: 'active' | 'pending_approval' = 'active') => {
      const [su] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: admission, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [s] = await db.insert(schema.students).values({ schoolId, userId: su!.id, admissionNumber: admission, firstName: 'Stu' + admission, lastName: 'Dent', status }).returning();
      return s!;
    };
    const inA = [await student(code + '01'), await student(code + '02')];
    const inB = [await student(code + '03')];
    const pending = await student(code + '04', 'pending_approval');
    await db.insert(schema.enrollments).values([
      ...inA.map(s => ({ schoolId, studentId: s.id, classId: classes[0]!.id, sessionId: session!.id, status: 'active' as const })),
      ...inB.map(s => ({ schoolId, studentId: s.id, classId: classes[1]!.id, sessionId: session!.id, status: 'active' as const })),
    ]);

    // Results pipeline: SS1 A has one published student and one draft student
    // for Maths; SS1 B has nothing.
    await db.insert(schema.subjectResults).values([
      { schoolId, studentId: inA[0]!.id, subjectId: subjects[0]!.id, sessionId: session!.id, termId: term!.id, state: 'published', published: true, total: '70', grade: 'B2' },
      { schoolId, studentId: inA[1]!.id, subjectId: subjects[0]!.id, sessionId: session!.id, termId: term!.id, state: 'draft', total: '0' },
    ]);

    // An authored question set so "questions written" is real data.
    const [set] = await db.insert(schema.questionSets).values({
      schoolId, sessionId: session!.id, termId: term!.id, subjectId: subjects[0]!.id,
      levelId: level!.id, examType: 'objective', teacherId: teacher!.id,
    }).returning();
    await db.insert(schema.questions).values([
      { schoolId, questionSetId: set!.id, questionText: '2+2?', marks: '1.00' },
      { schoolId, questionSetId: set!.id, questionText: '3+3?', marks: '1.00' },
    ]);

    // A parent with two linked children: one shared, one withheld.
    const parentUser = await user('parent');
    const [guardian] = await db.insert(schema.guardians).values({ schoolId, userId: parentUser.id, fullName: 'Shared Parent' }).returning();
    const sharedChild = inA[0]!;
    const withheldChild = inB[0]!;
    await db.insert(schema.guardianStudent).values([
      { schoolId, guardianId: guardian!.id, studentId: sharedChild.id, canViewResults: true },
      { schoolId, guardianId: guardian!.id, studentId: withheldChild.id, canViewResults: false },
    ]);

    const actor = (role: string, userId: number, staffId: number | null = null, studentId: number | null = null): Actor =>
      ({ userId, schoolId, role, loginId: role, staffId, studentId });

    return {
      actor, schoolId, session, term, classes, subjects, teacher, otherTeacher,
      teacherActor: actor('teacher', teacherUser.id, teacher!.id),
      otherTeacherActor: actor('teacher', otherUser.id, otherTeacher!.id),
      principalActor: actor('principal', principalUser.id),
      vpActor: actor('vice_principal', vpUser.id),
      officerActor: actor('exam_officer', officerUser.id),
      parentActor: actor('parent', parentUser.id),
      parentUserId: parentUser.id, pending,
    };
  }

  const cleanup = async () => {
    for (const id of [...schoolIds].reverse()) {
      await db.delete(schema.schools).where(eq(schema.schools.id, id));
    }
  };

  try {
    const a = await fixture();

    await check('school dashboard returns null for a teacher (role gate)', async () => {
      assert.equal(await schoolDashboard(a.teacherActor), null);
    });

    await check('teacher dashboard returns null for the office and parents', async () => {
      assert.equal(await teacherDashboard(a.principalActor), null);
      assert.equal(await teacherDashboard(a.parentActor), null);
    });

    const dash = await teacherDashboard(a.teacherActor);
    await check('teacher dashboard resolves the current session and term', () => {
      assert.equal(dash!.session!.title, '2025/26');
      assert.equal(dash!.term!.title, 'First');
    });

    await check('teacher dashboard groups subject assignments by subject with per-class counts', () => {
      assert.equal(dash!.subjects.length, 2);
      const maths = dash!.subjects.find(s => s.subjectName === 'Maths')!;
      const bio = dash!.subjects.find(s => s.subjectName === 'Biology')!;
      assert.equal(maths.classes.length, 1);
      assert.equal(maths.classes[0]!.className, 'SS1 A');
      assert.equal(maths.classes[0]!.students, 2);
      assert.equal(bio.classes.length, 1);
      assert.equal(bio.classes[0]!.className, 'SS1 B');
      assert.equal(bio.classes[0]!.students, 1);
    });

    await check('class-teacher heading is never treated as a subject assignment', () => {
      assert.equal(dash!.subjects.find(s => s.subjectName === null), undefined);
      assert.equal(dash!.subjects.reduce((n, s) => n + s.classes.length, 0), 2);
    });

    await check('my students counts only students in classes the teacher heads', () => {
      assert.equal(dash!.headed.length, 1);
      assert.equal(dash!.headed[0]!.className, 'SS1 A');
      assert.equal(dash!.myStudents, 2);
    });

    await check('class results pipeline reports headed class stages for the current term', () => {
      const pipeline = dash!.headed[0]!.pipeline;
      const published = pipeline.find(p => p.state === 'published')!;
      const draft = pipeline.find(p => p.state === 'draft')!;
      assert.equal(published.students, 1);
      assert.equal(draft.students, 1);
    });

    await check('questions written counts only the teacher authored set', () => {
      assert.equal(dash!.questionsWritten, 2);
    });

    await check('marking queue composes into the dashboard shape', () => {
      assert.equal(dash!.marking.outstanding, 0);
      assert.deepEqual(dash!.marking.subjects, []);
    });

    const other = await teacherDashboard(a.otherTeacherActor);
    await check('a teacher only ever sees their own assignments', () => {
      assert.equal(other!.subjects.length, 1);
      assert.equal(other!.subjects[0]!.subjectName, 'Biology');
      assert.equal(other!.headed.length, 0);
      assert.equal(other!.myStudents, 0);
    });

    const principalDash = await schoolDashboard(a.principalActor);
    await check('principal dashboard counts active students, staff and classes', () => {
      assert.equal(principalDash!.students, 3);
      assert.equal(principalDash!.staff, 5);
      assert.equal(principalDash!.classes, 2);
    });

    await check('principal dashboard surfaces pending student approvals', () => {
      assert.equal(principalDash!.pendingApprovals, 1);
    });

    await check('principal dashboard pipeline lists class stages for the term', () => {
      const row = principalDash!.pipeline.find(p => p.className === 'SS1 A' && p.state === 'published')!;
      assert.equal(row.students, 1);
    });

    await check('activity panel is present for principal and VP and hidden from the exam officer', async () => {
      const vpDash = await schoolDashboard(a.vpActor);
      const officerDash = await schoolDashboard(a.officerActor);
      assert.notEqual(principalDash!.activity, null);
      assert.notEqual(vpDash!.activity, null);
      assert.equal(officerDash!.activity, null);
    });

    // 45 audit events → 3 pages of 20 / 20 / 5.
    const events = Array.from({ length: 45 }, (_, i) => ({ schoolId: a.schoolId, action: 'ca.score_entered', actorRole: 'teacher', entityType: 'score', entityId: 0, createdAt: new Date(Date.now() + i * 1000) }));
    await db.insert(schema.auditLog).values(events);

    await check('activity page is refused for a teacher', async () => {
      assert.equal(await activityPage(a.teacherActor, 1), null);
      assert.equal(canViewActivity(a.teacherActor), false);
    });

    const page1 = await activityPage(a.principalActor, 1);
    await check('activity page paginates newest first', async () => {
      assert.equal(page1!.total, 45);
      assert.equal(page1!.pages, 3);
      assert.equal(page1!.page, 1);
      assert.equal(page1!.rows.length, 20);
      assert.equal(page1!.rows[0]!.createdAt.getTime() >= page1!.rows[19]!.createdAt.getTime(), true);
    });

    await check('activity page clamps an out-of-range page number', async () => {
      const far = await activityPage(a.vpActor, 99);
      assert.equal(far!.page, 3);
      assert.equal(far!.rows.length, 5);
    });

    await check('activity page is scoped to the caller school', async () => {
      const b = await fixture();
      const otherSchool = await activityPage(b.principalActor, 1);
      assert.equal(otherSchool!.total, 0);
      assert.equal(otherSchool!.rows.length, 0);
    });

    const children = await forSchool(a.parentActor.schoolId, tx => guardianChildren(tx, a.parentUserId));
    await check('parent dashboard lists shared and withheld children', () => {
      assert.equal(children.length, 2);
      const shared = children.find(c => c.id === children.find(() => false)?.id) ? null : children.find(c => c.canViewResults);
      const withheld = children.find(c => !c.canViewResults);
      assert.ok(shared);
      assert.ok(withheld);
      assert.ok(shared!.terms.length >= 0);
      assert.equal(withheld!.terms.length, 0);
    });

    await check('the shared child carries the published term, the withheld child does not', () => {
      const shared = children.find(c => c.canViewResults)!;
      assert.equal(shared.terms.length, 1);
      assert.equal(shared.terms[0]!.termId, a.term!.id);
      assert.equal(shared.terms[0]!.subjects, 1);
    });

    await check('school dashboard counts exclude pending students from active totals', async () => {
      const fresh = await fixture();
      const dash2 = await schoolDashboard(fresh.principalActor);
      assert.equal(dash2!.students, 3); // 3 active, 1 pending
      assert.equal(dash2!.pendingApprovals, 1);
    });

    console.log(`\n${count} PASS / 0 FAIL`);
    await cleanup();
    process.exit(0);
  } catch (error) {
    console.log(`\nFAIL after ${count} passes`);
    console.error(error);
    await cleanup();
    process.exit(1);
  }
}

main();
