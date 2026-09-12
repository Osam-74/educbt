/**
 * Exam timetable + invigilation integration checks.
 * Run with the app-role and owner URLs pointing at a disposable LOCAL
 * database; never at production.
 *   npx tsx src/db/test-timetable.ts
 *
 * Legacy reference: templates/portal/exams/{timetable,invigilation,invigilate}.php,
 * includes/Services/{TimetableService,InvigilationScheduleService,InvigilatorService}.php.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Timetable integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema, forSchool } = await import('@/db');
  const timetable = await import('@/lib/exam/timetable');
  const invigilate = await import('@/lib/exam/invigilate');
  const engine = await import('@/lib/exam/engine');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };

  const actor = (userId: number, schoolId: number, role: string, staffId: number | null, studentId: number | null = null): Actor =>
    ({ userId, schoolId, role, loginId: 'test', staffId, studentId });

  async function fixture() {
    const code = 'TT' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Timetable test', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS3' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS3 A', arm: 'A' }).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Maths', code: 'MTH', isCompulsory: true },
      { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
    ]).returning();

    const user = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'parent' | 'student', tag = '') => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
      return u!;
    };
    const officerUser = await user('exam_officer');
    const [officerStaff] = await db.insert(schema.staff).values({ schoolId, userId: officerUser.id, role: 'exam_officer', staffNumber: 'X0', firstName: 'Ex', lastName: 'Officer', status: 'active' }).returning();
    const tA = await user('teacher', 'a');
    const [staffA] = await db.insert(schema.staff).values({ schoolId, userId: tA.id, role: 'teacher', staffNumber: 'T0', firstName: 'Ann', lastName: 'Arbor', status: 'active' }).returning();
    const tB = await user('teacher', 'b');
    const [staffB] = await db.insert(schema.staff).values({ schoolId, userId: tB.id, role: 'teacher', staffNumber: 'T1', firstName: 'Bob', lastName: 'Biney', status: 'active' }).returning();

    // Teacher A teaches Maths in SS3 A. Teacher B teaches Biology in SS3 A.
    // Teacher D teaches nothing — the office can put them anywhere.
    await db.insert(schema.staffAssignments).values([
      { schoolId, staffId: staffA!.id, classId: klass!.id, subjectId: subjects[0]!.id, assignmentType: 'subject_teacher', status: 'active' },
      { schoolId, staffId: staffB!.id, classId: klass!.id, subjectId: subjects[1]!.id, assignmentType: 'subject_teacher', status: 'active' },
    ]);

    const tD = await user('teacher', 'd');
    const [staffD] = await db.insert(schema.staff).values({ schoolId, userId: tD.id, role: 'teacher', staffNumber: 'T3', firstName: 'Dee', lastName: 'Niente', status: 'active' }).returning();

    const students: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const su = await user('student', 's' + i);
      const [st] = await db.insert(schema.students).values({ schoolId, userId: su.id, admissionNumber: 'TT-S' + i, firstName: 'Cand', lastName: String(i), status: 'active' }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: klass!.id, sessionId: session!.id, status: 'active' });
      await db.insert(schema.studentSubjects).values([
        { schoolId, studentId: st!.id, subjectId: subjects[0]!.id, sessionId: session!.id },
        { schoolId, studentId: st!.id, subjectId: subjects[1]!.id, sessionId: session!.id },
      ]);
      students.push(st!.id);
    }

    // Two published papers for the same class, sequential slots.
    const [series] = await db.insert(schema.examSeries).values({
      schoolId, sessionId: session!.id, termId: term!.id,
      title: 'TT Terminal', seriesType: 'examination',
      sittingOpensAt: new Date(Date.now() - 24 * 3600 * 1000),
      sittingClosesAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      status: 'published',
    }).returning();

    const at = (hourFromNow: number) => new Date(Date.now() + hourFromNow * 3600 * 1000);
    const paper = async (subjectId: number, startsIn: number) => {
      const start = at(startsIn);
      const [p] = await db.insert(schema.examPapers).values({
        schoolId, seriesId: series!.id, subjectId, classId: klass!.id, levelId: level!.id,
        scheduledAt: start,
        durationSeconds: 3600,
        status: 'published',
        questionCount: 2,
      }).returning();
      await db.update(schema.examPapers).set({ closesAt: new Date(start.getTime() + 3600_000) })
        .where(eq(schema.examPapers.id, p!.id));
      return p!;
    };
    const maths = await paper(subjects[0]!.id, 1);
    const bio = await paper(subjects[1]!.id, 3);

    // Two objective questions per subject so attempts can actually start.
    const [setRow] = await db.insert(schema.questionSets).values({
      schoolId, sessionId: session!.id, termId: term!.id, subjectId: subjects[0]!.id,
      levelId: level!.id, examType: 'objective', status: 'approved',
    }).returning();
    const [setRowB] = await db.insert(schema.questionSets).values({
      schoolId, sessionId: session!.id, termId: term!.id, subjectId: subjects[1]!.id,
      levelId: level!.id, examType: 'objective', status: 'approved',
    }).returning();
    const poolFor = async (setId: number, paperId: number) => {
      for (let i = 0; i < 2; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: setId, questionText: 'Q' + i, questionType: 'single_choice', marks: '1.00' }).returning();
        await db.insert(schema.questionOptions).values([
          { schoolId, questionId: q!.id, optionText: 'Right', isCorrect: true },
          { schoolId, questionId: q!.id, optionText: 'Wrong', isCorrect: false },
        ]);
        await db.insert(schema.paperQuestions).values({ schoolId, paperId, questionId: q!.id, sortOrder: i });
      }
    };
    await poolFor(setRow!.id, maths.id);
    await poolFor(setRowB!.id, bio.id);

    return { schoolId, session, term, klass, level, subjects, officerUser, officerStaff, staffA, staffB, staffD, students, series, maths, bio, code };
  }

  const raw = await fixture();
  const F = { ...raw, officerStaff: raw.officerStaff!, staffA: raw.staffA!, staffB: raw.staffB!, staffD: raw.staffD!, series: raw.series!, session: raw.session!, term: raw.term!, klass: raw.klass!, level: raw.level!, maths: raw.maths!, bio: raw.bio! };
  const office = actor(F.officerUser.id, F.schoolId, 'exam_officer', F.officerStaff.id);
  const teacherA = actor((await db.select().from(schema.users).where(eq(schema.users.loginId, 'teachera-' + F.code)).limit(1))[0]!.id, F.schoolId, 'teacher', F.staffA.id);
  const teacherB = actor((await db.select().from(schema.users).where(eq(schema.users.loginId, 'teacherb-' + F.code)).limit(1))[0]!.id, F.schoolId, 'teacher', F.staffB.id);

  // ── The timetable view ────────────────────────────────────────────────────
  const view = await timetable.timetableForSeries(office, Number(F.series.id));
  assert.ok(view && view.papers.length === 2 && view.manage, 'office sees the draft timetable');
  assert.equal(view!.papers[0]!.subjectName, 'Maths', 'papers ordered by slot');

  await check('release gate hides a draft timetable from teachers', async () => {
    // A second, DRAFT series: teachers must see nothing until release.
    const [draft] = await db.insert(schema.examSeries).values({
      schoolId: F.schoolId, sessionId: F.session!.id, termId: F.term!.id,
      title: 'TT draft', seriesType: 'examination', status: 'draft',
    }).returning();
    await db.insert(schema.examPapers).values({
      schoolId: F.schoolId, seriesId: draft!.id, subjectId: F.subjects[0]!.id,
      classId: F.klass!.id, status: 'draft',
    });
    const hidden = await timetable.timetableForSeries(teacherA, Number(draft!.id));
    assert.ok(hidden && hidden.papers.length === 0 && !hidden.manage, 'draft papers are invisible to teachers');
    assert.equal(hidden!.series.released, false, 'draft series is not released');
    const visible = await timetable.timetableForSeries(office, Number(draft!.id));
    assert.ok(visible && visible.manage, 'office still manages the draft');
  });

  await check('a published series is released to teachers', async () => {
    const tv = await timetable.timetableForSeries(teacherA, Number(F.series.id));
    assert.ok(tv && tv.papers.length === 2 && !tv.manage, 'teacher sees the released timetable read-only');
  });

  await check('another school sees nothing', async () => {
    const stranger = { userId: 1, schoolId: F.schoolId + 1, role: 'exam_officer', loginId: 'x', staffId: null, studentId: null } as Actor;
    const other = await timetable.timetableForSeries(stranger, Number(F.series.id));
    assert.equal(other, null, 'cross-school series is invisible');
  });

  // ── Rescheduling ──────────────────────────────────────────────────────────
  await check('reschedule moves a slot and recomputes closes_at', async () => {
    const target = new Date(Date.now() + 5 * 3600 * 1000);
    const r = await timetable.reschedulePaper(office, Number(F.bio.id), { scheduledAt: target.toISOString(), durationMinutes: 90 });
    assert.ok(r.ok, 'reschedule accepted');
    const [row] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.bio.id)).limit(1);
    assert.equal(Math.round((row!.scheduledAt!.getTime() - target.getTime()) / 60000), 0, 'start moved');
    assert.equal(row!.durationSeconds, 5400, 'duration moved');
    assert.equal(row!.closesAt!.getTime() - row!.scheduledAt!.getTime(), 5400_000, 'closes_at recomputed');
  });

  await check('a class cannot sit two papers at once', async () => {
    // Bio now sits 5h→6.5h from now. Move Maths onto the same window.
    const r = await timetable.reschedulePaper(office, Number(F.maths.id), {
      scheduledAt: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString(), durationMinutes: 60,
    });
    assert.ok(!r.ok && r.error === 'clash', 'clash refused');
    assert.ok(r.clashWith === 'Biology', 'the clash is named');
  });

  await check('an override places both papers in one hall', async () => {
    const r = await timetable.reschedulePaper(office, Number(F.maths.id), {
      scheduledAt: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString(), durationMinutes: 60,
    }, true);
    assert.ok(r.ok, 'forced reschedule accepted');
  });

  await check('a teacher cannot reschedule', async () => {
    const r = await timetable.reschedulePaper(teacherA, Number(F.maths.id), { durationMinutes: 10 });
    assert.ok(!r.ok, 'role gate holds');
  });

  // ── Invigilator assignment ───────────────────────────────────────────────
  await check('a subject teacher never invigilates their own paper', async () => {
    const r = await timetable.setPaperInvigilator(office, Number(F.maths.id), F.staffA.id);
    assert.ok(!r.ok && r.error === 'teaches_this_subject', 'own subject refused');
  });

  await check('a clash-free assignment sticks', async () => {
    const r = await timetable.setPaperInvigilator(office, Number(F.maths.id), F.staffD.id);
    assert.ok(r.ok, 'teacher D takes Maths invigilation');
  });

  await check('nobody is in two halls at once', async () => {
    // Bio now overlaps Maths (5h→6.5h vs 5.5h→6.5h). D is already on Maths.
    const r = await timetable.setPaperInvigilator(office, Number(F.bio.id), F.staffD.id);
    assert.ok(!r.ok && r.error === 'already_invigilating_then', 'overlap refused');
    const forced = await timetable.setPaperInvigilator(office, Number(F.bio.id), F.staffD.id, true);
    assert.ok(forced.ok, 'override allowed — one CBT hall');
  });

  await check('clearing an invigilator works', async () => {
    const r = await timetable.setPaperInvigilator(office, Number(F.bio.id), 0);
    assert.ok(r.ok, 'invigilator cleared');
  });

  // ── Auto-proposal ────────────────────────────────────────────────────────
  await check('the proposal spreads load and avoids own subjects', async () => {
    // Separate the papers so neither overlaps: Maths 9h, Bio 3h from now.
    await timetable.reschedulePaper(office, Number(F.maths.id), {
      scheduledAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString(), durationMinutes: 60,
    }, true);
    await db.update(schema.examPapers).set({ invigilatorStaffId: null })
      .where(eq(schema.examPapers.id, F.maths.id));
    await db.update(schema.examPapers).set({ invigilatorStaffId: null })
      .where(eq(schema.examPapers.id, F.bio.id));

    const result = await timetable.proposeInvigilation(office, Number(F.series.id));
    assert.ok(result, 'proposal ran');
    assert.equal(result!.assigned, 2, 'both papers covered');
    assert.equal(result!.unfilled.length, 0, 'nothing unfilled');
    const [mathsRow] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    const [bioRow] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.bio.id)).limit(1);
    // A teaches Maths, B teaches Biology — neither may take their own paper.
    // D teaches nothing, so D is eligible everywhere. Whoever is chosen, load
    // is spread so one teacher does not end up in every hall.
    const chosenMaths = mathsRow!.invigilatorStaffId;
    const chosenBio = bioRow!.invigilatorStaffId;
    assert.ok([F.staffB.id, F.staffD.id].includes(chosenMaths!), 'Maths invigilated by B or D');
    assert.ok([F.staffA.id, F.staffD.id].includes(chosenBio!), 'Biology invigilated by A or D');
    assert.notEqual(chosenMaths, chosenBio, 'load is spread across teachers');
  });

  await check('drift reports an unfilled paper after the timetable moved', async () => {
    await db.update(schema.examPapers).set({ invigilatorStaffId: null })
      .where(eq(schema.examPapers.id, F.bio.id));
    const issues = await timetable.invigilationDrift(office, Number(F.series.id));
    assert.ok(issues.some((i) => i.includes('has no invigilator')), 'unfilled paper reported');
  });

  // ── Access codes ─────────────────────────────────────────────────────────
  await check('access codes generate, release and invalidate', async () => {
    const g1 = await timetable.regenerateAccessCode(office, Number(F.maths.id));
    assert.ok(g1.ok && g1.code && /^[A-Z2-9]{6}$/.test(g1.code), 'code generated');
    const [row1] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    assert.equal(row1!.accessCode, g1.code, 'code stored');
    assert.equal(row1!.requiresAccessCode, true, 'gate on');

    const rel = await timetable.releaseAccessCode(office, Number(F.maths.id));
    assert.ok(rel.ok, 'release recorded');
    const [row2] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    assert.ok(row2!.codeReleasedAt, 'release stamped');

    const g2 = await timetable.regenerateAccessCode(office, Number(F.maths.id));
    assert.ok(g2.ok && g2.code !== g1.code, 'regeneration changes the code');
    const [row3] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    assert.equal(row3!.codeReleasedAt, null, 'regeneration clears the release');
  });

  await check('a candidate cannot start without the code', async () => {
    const s = await engine.startAttempt(F.schoolId, Number(F.maths.id), F.students[0]!);
    assert.ok(!s.ok && s.reason === 'access_code_required', 'gate asks for the code');
    const wrong = await engine.startAttempt(F.schoolId, Number(F.maths.id), F.students[0]!, 'NOPE12');
    assert.ok(!wrong.ok && wrong.reason === 'access_code_wrong', 'wrong code refused');
    const [row] = await db.select({ code: schema.examPapers.accessCode }).from(schema.examPapers)
      .where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    const right = await engine.startAttempt(F.schoolId, Number(F.maths.id), F.students[0]!, row!.code!.toLowerCase());
    assert.ok(right.ok && !right.resumed, 'right code opens the paper (case-insensitive)');
  });

  // ── The live board ───────────────────────────────────────────────────────
  const [attemptRow] = await db.select().from(schema.attempts)
    .where(eq(schema.attempts.paperId, F.maths.id)).limit(1);
  assert.ok(attemptRow, 'attempt exists');

  await check('the board counts not-started, writing and quiet candidates', async () => {
    // Candidates 2 and 3 have no attempt yet; candidate 1 has gone quiet.
    await db.update(schema.attempts)
      .set({ lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000), integrityCount: 2 })
      .where(eq(schema.attempts.id, attemptRow!.id));
    const board = await invigilate.boardFor(office, Number(F.maths.id));
    assert.ok(board, 'office sees the board');
    assert.equal(board!.summary.notStarted, 2, 'two candidates have not started');
    assert.equal(board!.summary.inProgress, 1, 'one is writing');
    assert.equal(board!.summary.quiet, 1, 'one is quiet');
    const quietRow = board!.students.find((s) => s.attemptId === Number(attemptRow!.id));
    assert.equal(quietRow!.flags, 2, 'integrity flags surface');
    assert.ok(quietRow!.remainingSeconds! > 0, 'time left is live');
  });

  await check('the assigned invigilator and the subject teacher watch; strangers do not', async () => {
    await db.update(schema.examPapers).set({ invigilatorStaffId: F.staffB.id })
      .where(eq(schema.examPapers.id, F.maths.id));
    const asB = await invigilate.boardFor(teacherB, Number(F.maths.id));
    assert.ok(asB && asB.canIntervene, 'assigned invigilator can watch and intervene');
    // A new teacher with no assignments sees nothing.
    const tC = await db.insert(schema.users).values({ schoolId: F.schoolId, role: 'teacher', loginId: 'teacherc-' + F.code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staffC] = await db.insert(schema.staff).values({ schoolId: F.schoolId, userId: tC[0]!.id, role: 'teacher', staffNumber: 'T2', firstName: 'Cat', lastName: 'Stranger', status: 'active' }).returning();
    const stranger = actor(tC[0]!.id, F.schoolId, 'teacher', staffC!.id);
    const refused = await invigilate.boardFor(stranger, Number(F.maths.id));
    assert.equal(refused, null, 'uninvolved teacher is refused');

  });

  await check('live papers scope by subject and invigilation', async () => {
    const officeLive = await invigilate.livePapers(office);
    assert.ok(officeLive.length >= 2, 'office sees live papers');
    const aLive = await invigilate.livePapers(teacherA);
    assert.ok(aLive.some((p) => p.subjectName === 'Maths'), 'subject teacher A sees Maths (their subject)');
    assert.ok(!aLive.some((p) => p.subjectName === 'Biology'), 'A does not see the paper of a subject they do not teach');
    // A teacher with no assignments and no invigilation duties sees nothing.
    const tC = await db.insert(schema.users).values({ schoolId: F.schoolId, role: 'teacher', loginId: 'tt-stranger-' + F.code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staffC] = await db.insert(schema.staff).values({ schoolId: F.schoolId, userId: tC[0]!.id, role: 'teacher', staffNumber: 'T9', firstName: 'Nobody', lastName: 'Here', status: 'active' }).returning();
    const strangerLive = await invigilate.livePapers(actor(tC[0]!.id, F.schoolId, 'teacher', staffC!.id));
    assert.equal(strangerLive.length, 0, 'uninvolved teacher sees no live papers');
    const asB = await invigilate.boardFor(teacherB, Number(F.bio.id));
    assert.ok(asB, 'subject teacher of Biology may watch Biology');
    const notA = await invigilate.boardFor(teacherA, Number(F.bio.id));
    assert.equal(notA, null, 'A cannot watch a paper outside their subjects');
  });

  // ── Interventions ────────────────────────────────────────────────────────
  await check('extra time moves the server clock and needs a reason', async () => {
    const before = (await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptRow!.id)).limit(1))[0]!;
    const noReason = await invigilate.grantExtension(office, Number(attemptRow!.id), 5, '   ');
    assert.ok(!noReason.ok && noReason.error === 'reason_required', 'a reason is required');
    const tooMuch = await invigilate.grantExtension(office, Number(attemptRow!.id), 130, 'power outage');
    assert.ok(!tooMuch.ok && tooMuch.error === 'implausible_extension', 'implausible time refused');
    const ok = await invigilate.grantExtension(office, Number(attemptRow!.id), 5, 'Power outage');
    assert.ok(ok.ok, 'extension granted');
    const after = (await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptRow!.id)).limit(1))[0]!;
    assert.equal(after.extensionSeconds, before.extensionSeconds + 300, 'extension recorded');
    assert.equal(after.expiresAt.getTime() - before.expiresAt.getTime(), 300_000, 'expires_at moved by the same amount');
    const [audit] = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, Number(attemptRow!.id))).limit(1);
    void audit;
  });

  await check('the whole hall can be extended at once', async () => {
    // Candidate 2 starts (with the paper's access code), then the hall is extended.
    const [mathsCode] = await db.select({ code: schema.examPapers.accessCode }).from(schema.examPapers)
      .where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    const start = await engine.startAttempt(F.schoolId, Number(F.maths.id), F.students[1]!, mathsCode!.code!);
    assert.ok(start.ok, 'candidate 2 started');
    const result = await invigilate.extendPaper(office, Number(F.maths.id), 6, 'Generator failure');
    assert.ok(result.ok && result.attemptsExtended! >= 2, 'both writing candidates extended');
    const rows = await db.select().from(schema.attempts).where(eq(schema.attempts.paperId, F.maths.id));
    assert.ok(rows.every((r) => r.status !== 'in_progress' || r.extensionSeconds > 0), 'in-progress attempts carry the extension');
  });

  await check('a forced submission marks answers as they stand and records why', async () => {
    const r = await invigilate.forceSubmit(office, Number(attemptRow!.id), 'Walked out of the hall');
    assert.ok(r.ok, 'force submit accepted');
    const [row] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptRow!.id)).limit(1);
    assert.equal(row!.status, 'submitted', 'attempt closed');
    assert.ok(row!.submitReason!.startsWith('forced:'), 'reason recorded on the attempt');
    assert.ok(row!.score !== null, 'answers marked as they stand');
  });

  await check('a parent sees only future papers for their own children', async () => {
    const pu = await db.insert(schema.users).values({ schoolId: F.schoolId, role: 'parent', loginId: 'parent-' + F.code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [guardian] = await db.insert(schema.guardians).values({ schoolId: F.schoolId, userId: pu[0]!.id, fullName: 'Pa Rent', phone: '080' }).returning();
    await db.insert(schema.guardianStudent).values({ schoolId: F.schoolId, guardianId: guardian!.id, studentId: F.students[0]!, canViewResults: true });
    const parentActor = actor(pu[0]!.id, F.schoolId, 'parent', null);
    const board = await invigilate.boardFor(parentActor, Number(F.maths.id));
    assert.equal(board, null, 'parents cannot watch a live board');
    const papers = await forSchool(F.schoolId, async (tx) =>
      timetable.upcomingForStudent(tx, F.schoolId, F.students[0]!, 20));
    assert.ok(papers.length >= 1 && papers.every((p) => p.scheduledAt.getTime() > Date.now()), 'only upcoming papers surface');
  });


  // ---- HTTP checks: the pages around the timetable, against a live server. ----
  await check('HTTP pages render and gate by role', async () => {
  if (!process.env.CA_TEST_HTTP_URL) {
    console.log('SKIP  HTTP section (set CA_TEST_HTTP_URL to a running server)');
    return;
  }
  {
    const base = new URL(process.env.CA_TEST_HTTP_URL); assert(['localhost', '127.0.0.1'].includes(base.hostname));
    const mkSession = async (userId: number) => {
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 300000) });
      const headers = { cookie: 'educbt.session=' + token };
      return { headers, plain: async (path: string) => fetch(new URL(path, base), { headers, redirect: 'manual' }) };
    };
    const officeHttp = await mkSession(F.officerUser.id);
    const teacherRow = await db.select({ userId: schema.staff.userId }).from(schema.staff)
      .where(eq(schema.staff.id, F.staffA.id)).limit(1);
    const teacherHttp = await mkSession(teacherRow[0]!.userId!);
    const guardianRow = await db.select({ userId: schema.guardians.userId }).from(schema.guardians)
      .where(eq(schema.guardians.schoolId, F.schoolId)).limit(1);
    const parentHttp = await mkSession(guardianRow[0]!.userId!);
    const studentRow = await db.select({ userId: schema.students.userId }).from(schema.students)
      .where(eq(schema.students.id, F.students[2]!)).limit(1);
    const studentHttp = await mkSession(studentRow[0]!.userId!);

    // The office manages the timetable: slots, invigilators, access codes.
    const officeTimetable = await (await officeHttp.plain(`/portal/timetable?series=${F.series.id}`)).text();
    assert.ok(officeTimetable.includes('Save slot'), 'office sees the reschedule controls');
    assert.ok(officeTimetable.includes('Maths') && officeTimetable.includes('Biology'), 'office sees both papers');

    // A teacher sees the released timetable but not the office controls.
    const teacherTimetable = await (await teacherHttp.plain(`/portal/timetable?series=${F.series.id}`)).text();
    assert.ok(teacherTimetable.includes('Maths'), 'teacher sees the timetable');
    assert.ok(!teacherTimetable.includes('Save slot'), 'teacher has no office controls');

    // A parent sees their child's upcoming papers — not the office table.
    const parentTimetable = await (await parentHttp.plain('/portal/timetable')).text();
    assert.ok(parentTimetable.includes('Cand'), 'parent sees their child');
    assert.ok(!parentTimetable.includes('Save slot'), 'parent has no office controls');

    // Students are redirected away from the timetable page entirely.
    const studentTimetable = await studentHttp.plain('/portal/timetable');
    assert.equal(studentTimetable.status, 307, 'student is redirected from the timetable');
    const studentInvigilation = await studentHttp.plain('/portal/invigilation');
    assert.equal(studentInvigilation.status, 404, 'student cannot reach invigilation');
    const parentBoard = await parentHttp.plain(`/portal/invigilate/${F.maths.id}`);
    assert.equal(parentBoard.status, 404, 'parent cannot watch a live board');

    // The invigilation page shows the proposal button and the drift.
    const invigilation = await (await officeHttp.plain(`/portal/invigilation?series=${F.series.id}`)).text();
    assert.ok(invigilation.includes('Create invigilation schedule') || invigilation.includes('Fill any gaps automatically'),
      'the proposal action renders (empty or partial schedule)');
    assert.ok(invigilation.includes('has no invigilator'), 'drift is reported for the uncovered paper');

    // The live session list and the board itself.
    const liveList = await (await officeHttp.plain('/portal/invigilate')).text();
    assert.ok(liveList.includes('Watch'), 'live session list renders with a watch link');
    const boardPage = await (await officeHttp.plain(`/portal/invigilate/${F.maths.id}`)).text();
    assert.ok(boardPage.includes('not started'), 'board counts render');

    // The access-code gate on the student's exam entry.
    const noCode = await (await studentHttp.plain(`/exam/${F.maths.id}`)).text();
    assert.ok(noCode.includes('Access code'), 'exam page asks for the code first');
    const [mathsCode] = await db.select({ code: schema.examPapers.accessCode }).from(schema.examPapers)
      .where(eq(schema.examPapers.id, F.maths.id)).limit(1);
    const withCode = await (await studentHttp.plain(`/exam/${F.maths.id}?code=${mathsCode!.code}`)).text();
    assert.ok(!withCode.includes('Access code'), 'the right code opens the paper');
  }
  });

  console.log(`\n${count} passed`);
  for (const id of schoolIds) {
    await db.delete(schema.schools).where(eq(schema.schools.id, id));
  }
  await owner.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  // The postgres pool keeps the process alive; give the sockets a moment to
  // drain so the runner exits even when an assertion failed mid-suite.
  setTimeout(() => process.exit(process.exitCode ?? 1), 500).unref?.();
});
