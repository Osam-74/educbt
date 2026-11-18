/**
 * School backup RESTORE checks: export a populated school, restore it as a NEW school, and prove the
 * copy is faithful, correctly linked, credential-free, isolated, and that failures leave nothing behind.
 *   npx tsx src/db/test-school-backup-restore.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Backup restore tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const { restoreSchool } = await import('@/lib/school-backup/restore');
  const { encode, decode } = await import('@/lib/school-backup/format');
  const { verifyPassword } = await import('@/lib/auth/password');
  const { DATA_TABLES } = await import('@/lib/school-backup/registry');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  // Plain arrays of plain objects, so deepStrictEqual compares data, not postgres.js's Result wrapper.
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];

  const SECRET_HASH = 'argon2id$ORIGINAL-HASH-' + randomUUID();
  const suffix = randomUUID().slice(0, 6).toUpperCase();

  // A platform admin to act as the operator.
  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'padmin-' + suffix, passwordHash: SECRET_HASH, mustChangePassword: false }).returning();

  async function buildSchool(label: string, tag: string) {
    const code = 'R' + tag;
    const [school] = await db.insert(schema.schools).values({ name: label, code, subdomain: code.toLowerCase(), address: '1 Palm Road', settings: { css: 'x', questionBank: {} } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1', levelOrder: 4 }).returning();
    const [dept] = await db.insert(schema.departments).values({ schoolId, name: 'Science' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, departmentId: dept!.id, displayName: 'SS1 A', arm: 'A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, name: 'Biology', code: 'BIO', isCompulsory: false, departmentId: dept!.id }).returning();

    const [pUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'PRN-' + tag, passwordHash: SECRET_HASH, email: `principal-${tag}@example.com`.toLowerCase(), mustChangePassword: false }).returning();
    await db.insert(schema.staff).values({ schoolId, userId: pUser!.id, role: 'principal', staffNumber: 'PRN-0001', firstName: 'Pat', lastName: 'Head' });
    const [tUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'T-' + tag, passwordHash: SECRET_HASH, totpSecret: 'TOTP' + tag, totpEnabled: true, mustChangePassword: false, email: `teacher-${tag}@example.com`.toLowerCase() }).returning();
    const [teacher] = await db.insert(schema.staff).values({ schoolId, userId: tUser!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Tunde', lastName: 'Bello' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher!.id, classId: klass!.id, subjectId: subject!.id, assignmentType: 'subject_teacher' });

    const photoToken = randomUUID().replace(/-/g, '') + 'ab';
    await db.insert(schema.portalUploads).values({ schoolId, token: photoToken, mimeType: 'image/png', byteSize: 4, data: Buffer.from([9, 8, 7, 6]) });
    const [sUser] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 'S-' + tag, passwordHash: SECRET_HASH, mustChangePassword: false }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId, userId: sUser!.id, admissionNumber: 'ADM/' + tag, firstName: 'Ada', lastName: 'Obi', photoUrl: '/api/photos/' + photoToken }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: student!.id, classId: klass!.id, sessionId: session!.id });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id });
    const [guardian] = await db.insert(schema.guardians).values({ schoolId, fullName: 'Mr Obi', inviteToken: 'INVITE-' + randomUUID() }).returning();
    await db.insert(schema.guardianStudent).values({ schoolId, guardianId: guardian!.id, studentId: student!.id, relationship: 'father', canViewResults: true });

    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First CA', seriesType: 'ca_test' }).returning();
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, examType: 'objective', seriesId: series!.id, teacherId: teacher!.id, submittedBy: tUser!.id }).returning();
    const [q1] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Cell wall?', questionType: 'single_choice' }).returning();
    const [q2] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Part b', questionType: 'single_choice', parentId: q1!.id, partLabel: 'b' }).returning();
    const [o1] = await db.insert(schema.questionOptions).values({ schoolId, questionId: q1!.id, optionText: 'Cellulose', isCorrect: true }).returning();
    await db.insert(schema.questionOptions).values({ schoolId, questionId: q1!.id, optionText: 'Keratin', isCorrect: false });
    await db.insert(schema.questionVault).values({ schoolId, questionSetId: set!.id, questionCount: 1, reason: { trigger: 'test' },
      payload: { version: 1, setId: set!.id, takenAt: 'now', questions: [{ row: { id: q1!.id, school_id: schoolId, question_set_id: set!.id }, options: [{ id: o1!.id, school_id: schoolId, question_id: q1!.id }] }] } });
    const [paper] = await db.insert(schema.examPapers).values({ schoolId, seriesId: series!.id, subjectId: subject!.id, classId: klass!.id, levelId: level!.id }).returning();
    await db.insert(schema.paperQuestions).values({ schoolId, paperId: paper!.id, questionId: q1!.id });
    const [attempt] = await db.insert(schema.attempts).values({ schoolId, paperId: paper!.id, studentId: student!.id, expiresAt: new Date(Date.now() + 3600e3), score: '7.50', maxScore: '10' }).returning();
    await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: attempt!.id, questionId: q1!.id, optionId: o1!.id, awardedMarks: '2.50' });
    await db.insert(schema.assessmentScores).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id, componentKey: 'ca1', score: '12.25', maxScore: '20' });
    await db.insert(schema.subjectResults).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id, total: '77.50', grade: 'A' });
    await db.insert(schema.announcements).values({ schoolId, authorUserId: pUser!.id, audience: 'class', audienceRef: klass!.id, subject: 'Hello', body: 'Welcome' });
    // Plugin-parity tables: term remarks and approval trail, theory part marks, school-wide remark wording.
    await db.insert(schema.termSummaries).values({ schoolId, studentId: student!.id, sessionId: session!.id, termId: term!.id, classId: klass!.id,
      classTeacherRemark: 'Hardworking pupil', principalRemark: 'Keep it up', daysPresent: 58, daysTotal: 60, subjectsOffered: 9, totalScore: '612.50',
      averageScore: '68.06', classPosition: 3, classSize: 31, status: 'published', submittedBy: tUser!.id, approvedBy: pUser!.id });
    await db.insert(schema.questionParts).values([
      { schoolId, questionId: q1!.id, label: 'a', text: 'Define osmosis.', marks: '2.00', sequence: 1 },
      { schoolId, questionId: q1!.id, label: 'b', text: 'Give one example in plants.', marks: '3.00', sequence: 2 }]);
    await db.insert(schema.schoolRemarkRanges).values({ schoolId, role: 'principal', minAvg: '70', maxAvg: '100', remark: 'Excellent result', sortOrder: 1 });
    await db.update(schema.schools).set({ settings: { css: 'x', questionBank: { seriesId: Number(series!.id) } }, logoUrl: '/api/photos/' + photoToken }).where(eq(schema.schools.id, schoolId));
    return { schoolId, code, photoToken, studentId: Number(student!.id), classId: Number(klass!.id), seriesId: Number(series!.id), principalLogin: 'PRN-' + tag };
  }

  const snapshotOf = async (schoolId: number) => {
    const out: Record<string, number> = {};
    for (const t of DATA_TABLES) out[t.table] = Number((await q(`select count(*)::int as n from ${t.table} where school_id = $1`, [schoolId]))[0]!.n);
    return out;
  };

  try {
    const A = await buildSchool('Greenfield College', suffix + 'A');
    const B = await buildSchool('Other Academy', suffix + 'B'); // a bystander that must never change
    const beforeA = await snapshotOf(A.schoolId);
    const beforeB = await snapshotOf(B.schoolId);
    const hashesBefore = await q('select id, password_hash from users where school_id = $1 order by id', [A.schoolId]);

    const exported = await exportSchool(A.schoolId);
    const result = await restoreSchool({ actorUserId: Number(admin!.id), file: exported.file, code: 'N' + suffix, subdomain: ('n' + suffix).toLowerCase() });
    schoolIds.push(result.school.id);
    const NEW = result.school.id;

    await check('a NEW school is created, not the old one overwritten', () => {
      assert.notEqual(NEW, A.schoolId); assert.equal(result.school.name, 'Greenfield College'); assert.equal(result.school.code, 'N' + suffix);
    });
    await check('the new school is open (active) only after everything succeeded', async () => {
      assert.equal((await q('select status::text as s from schools where id = $1', [NEW]))[0]!.s, 'active');
    });
    await check('every table has the same number of rows as the original (nothing lost, nothing added)', async () => {
      const after = await snapshotOf(NEW);
      for (const t of DATA_TABLES) {
        if (['audit_log', 'notifications'].includes(t.table)) continue; // the restore itself writes an audit entry
        assert.equal(after[t.table], beforeA[t.table], `${t.table}: original ${beforeA[t.table]}, restored ${after[t.table]}`);
      }
    });
    await check('the restored school shares no ids with the original (brand-new rows)', async () => {
      for (const t of ['students', 'subjects', 'classes', 'questions', 'attempts']) {
        const overlap = await q(`select count(*)::int as n from ${t} n join ${t} o on o.id = n.id where n.school_id = $1 and o.school_id = $2`, [NEW, A.schoolId]);
        assert.equal(overlap[0]!.n, 0);
      }
    });
    await check('LINKS: every foreign key in the new school points inside the new school', async () => {
      const bad = await q(`select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent from pg_constraint c where c.contype='f' and c.confrelid::regclass::text <> 'schools' and c.connamespace='public'::regnamespace`);
      for (const f of bad) {
        if (!DATA_TABLES.some((t) => t.table === f.child) || !DATA_TABLES.some((t) => t.table === f.parent)) continue;
        const cols = (await q(`select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.contype='f' and c.conrelid = $1::regclass and c.confrelid = $2::regclass and a.attname <> 'school_id'`, [f.child, f.parent])) as Array<{ attname: string }>;
        for (const { attname } of cols) {
          const leak = await q(`select count(*)::int as n from ${f.child} c join ${f.parent} p on p.id = c.${attname} where c.school_id = $1 and p.school_id <> $1`, [NEW]);
          assert.equal(leak[0]!.n, 0, `${f.child}.${attname} points into another school`);
        }
      }
    });
    await check('PARITY: term remarks, attendance, snapshot and approval trail survive exactly', async () => {
      const r = (await q(`select t.*, s.admission_number, u1.login_id as submitter, u2.login_id as approver from term_summaries t
        join students s on s.id = t.student_id left join users u1 on u1.id = t.submitted_by left join users u2 on u2.id = t.approved_by where t.school_id = $1`, [NEW]));
      assert.equal(r.length, 1);
      const x = r[0]!;
      assert.equal(x.class_teacher_remark, 'Hardworking pupil'); assert.equal(x.principal_remark, 'Keep it up');
      assert.equal(x.days_present, 58); assert.equal(x.days_total, 60); assert.equal(x.subjects_offered, 9);
      assert.equal(String(x.total_score), '612.50'); assert.equal(String(x.average_score), '68.06');
      assert.equal(x.class_position, 3); assert.equal(x.class_size, 31); assert.equal(x.status, 'published');
      // Linked to the RESTORED student, and to the restored teacher and principal logins (not the old ones).
      assert.equal(x.admission_number, 'ADM/' + A.code.slice(1)); assert.ok(x.submitter && x.approver);
      assert.notEqual(Number(x.student_id), A.studentId);
    });
    await check('PARITY: theory parts keep their labels, text, marks and order, on the RESTORED question', async () => {
      const r = await q(`select p.label, p.text, p.marks::text as marks, p.sequence, q.question_text, q.school_id as qschool from question_parts p
        join questions q on q.id = p.question_id where p.school_id = $1 order by p.sequence`, [NEW]);
      assert.deepEqual(r.map(x => [x.label, x.text, x.marks, x.sequence]), [['a', 'Define osmosis.', '2.00', 1], ['b', 'Give one example in plants.', '3.00', 2]]);
      assert.ok(r.every(x => Number(x.qschool) === NEW && x.question_text === 'Cell wall?'));
    });
    await check('PARITY: school-wide remark wording survives', async () => {
      const r = await q('select role, min_avg::text as lo, max_avg::text as hi, remark, status from school_remark_ranges where school_id = $1', [NEW]);
      assert.deepEqual(r.map(x => [x.role, x.lo, x.hi, x.remark, x.status]), [['principal', '70.00', '100.00', 'Excellent result', 'active']]);
    });
    await check('LINKS: results and scores point at the SAME student and subject (by name), not just any', async () => {
      const r = await q(`select s.first_name, s.last_name, sub.name as subject, r.total::text as total from subject_results r join students s on s.id = r.student_id join subjects sub on sub.id = r.subject_id where r.school_id = $1`, [NEW]);
      assert.deepEqual(r, [{ first_name: 'Ada', last_name: 'Obi', subject: 'Biology', total: '77.50' }]);
      const sc = await q(`select s.admission_number, a.score::text as score from assessment_scores a join students s on s.id = a.student_id where a.school_id = $1`, [NEW]);
      assert.equal(sc[0]!.score, '12.25');
    });
    await check('MARKS stay exact (no float rounding)', async () => {
      // The invariant is "the copy equals what the original stored", whatever scale Postgres gave it.
      const cols = `score::text as score, max_score::text as max`;
      const orig = await q(`select ${cols} from attempts where school_id = $1`, [A.schoolId]);
      assert.deepEqual(await q(`select ${cols} from attempts where school_id = $1`, [NEW]), orig);
      assert.equal(orig[0]!.score, '7.50');
      const m = `awarded_marks::text as m`;
      assert.deepEqual(await q(`select ${m} from attempt_answers where school_id = $1`, [NEW]), await q(`select ${m} from attempt_answers where school_id = $1`, [A.schoolId]));
      assert.equal((await q(`select ${m} from attempt_answers where school_id = $1`, [NEW]))[0]!.m, '2.50');
    });
    await check('the question parent link (second pass) points at the restored parent', async () => {
      const r = await q(`select c.question_text as child, p.question_text as parent from questions c join questions p on p.id = c.parent_id where c.school_id = $1 and p.school_id = $1`, [NEW]);
      assert.deepEqual(r, [{ child: 'Part b', parent: 'Cell wall?' }]);
    });
    await check('announcement audience points at the restored class', async () => {
      const r = await q(`select c.display_name from announcements a join classes c on c.id = a.audience_ref where a.school_id = $1 and c.school_id = $1`, [NEW]);
      assert.deepEqual(r, [{ display_name: 'SS1 A' }]);
    });
    await check('settings: the question-bank series points at the NEW series', async () => {
      const s = (await q(`select settings from schools where id = $1`, [NEW]))[0]!.settings as { questionBank: { seriesId: number } };
      const ok = await q(`select count(*)::int as n from exam_series where id = $1 and school_id = $2`, [s.questionBank.seriesId, NEW]);
      assert.equal(ok[0]!.n, 1); assert.notEqual(s.questionBank.seriesId, A.seriesId);
    });
    await check('the question vault still names real, restored rows', async () => {
      const v = (await q(`select payload from question_vault where school_id = $1`, [NEW]))[0]!.payload as { setId: number; questions: Array<{ row: { id: number; school_id: number }; options: Array<{ question_id: number }> }> };
      assert.equal((await q(`select count(*)::int as n from question_sets where id = $1 and school_id = $2`, [v.setId, NEW]))[0]!.n, 1);
      assert.equal((await q(`select count(*)::int as n from questions where id = $1 and school_id = $2`, [v.questions[0]!.row.id, NEW]))[0]!.n, 1);
      assert.equal(v.questions[0]!.row.school_id, NEW);
    });
    await check('PHOTOS: the student, the logo and the bytes all follow the NEW token', async () => {
      const st = (await q(`select photo_url from students where school_id = $1`, [NEW]))[0]!.photo_url as string;
      const token = st.split('/').pop()!;
      assert.notEqual(token, A.photoToken, 'the old token was reused');
      const up = await q(`select school_id, encode(data,'hex') as hex from portal_uploads where token = $1`, [token]);
      assert.equal(Number(up[0]!.school_id), NEW); assert.equal(up[0]!.hex, '09080706');
      assert.equal((await q(`select logo_url from schools where id = $1`, [NEW]))[0]!.logo_url, st);
    });
    await check('CREDENTIALS: no restored login has the original password hash or two-factor secret', async () => {
      const users = await q(`select login_id, password_hash, totp_secret, totp_enabled, must_change_password, role::text as role from users where school_id = $1`, [NEW]);
      assert.equal(users.length, 3, 'principal, teacher and student');
      for (const u of users) {
        assert.notEqual(u.password_hash, SECRET_HASH);
        assert.equal(u.totp_secret, null); assert.equal(u.totp_enabled, false); assert.equal(u.must_change_password, true);
        if (u.role !== 'principal') assert.ok(String(u.password_hash).startsWith('!restored-no-password!'), `${u.login_id} must have no usable password until one is issued`);
      }
    });
    await check('the principal gets a working temporary password that must be changed', async () => {
      const [p] = await q(`select password_hash, must_change_password from users where school_id = $1 and role = 'principal'`, [NEW]);
      assert.equal(result.principal.loginId, A.principalLogin); assert.ok(result.temporaryPassword && result.temporaryPassword.length >= 12);
      assert.equal(await verifyPassword(String(p!.password_hash), result.temporaryPassword!), true);
      assert.equal(p!.must_change_password, true);
    });
    await check('a restored non-principal login can NOT sign in with any password (placeholder never verifies)', async () => {
      const [t] = await q(`select password_hash from users where school_id = $1 and role = 'teacher'`, [NEW]);
      for (const guess of ['', 'password', SECRET_HASH, String(t!.password_hash), '!restored-no-password!']) {
        assert.equal(await verifyPassword(String(t!.password_hash), guess), false);
      }
      const hashes = (await q(`select password_hash from users where school_id = $1`, [NEW])).map((u) => u.password_hash);
      assert.equal(new Set(hashes).size, hashes.length, 'placeholders must be unique per user');
    });
    await check('guardian invite tokens are reset', async () => {
      assert.equal((await q(`select invite_token from guardians where school_id = $1`, [NEW]))[0]!.invite_token, null);
    });
    await check('emails already used by the original are cleared (no collision), logins still work by login id', async () => {
      const r = await q(`select login_id, email from users where school_id = $1 and role in ('principal','teacher') order by login_id`, [NEW]);
      for (const u of r) assert.equal(u.email, null);
    });
    await check('THE ORIGINAL SCHOOL IS UNTOUCHED (rows and password hashes identical)', async () => {
      assert.deepEqual(await snapshotOf(A.schoolId), beforeA);
      assert.deepEqual(await q('select id, password_hash from users where school_id = $1 order by id', [A.schoolId]), hashesBefore);
    });
    await check('an unrelated school is untouched', async () => assert.deepEqual(await snapshotOf(B.schoolId), beforeB));
    await check('the restore is recorded in the audit log', async () => {
      assert.equal((await q(`select count(*)::int as n from audit_log where school_id = $1 and action = 'school.restored_from_backup'`, [NEW]))[0]!.n, 1);
    });

    // ── failure behaviour ────────────────────────────────────────────────────
    const schoolsBefore = (await q('select count(*)::int as n from schools'))[0]!.n;
    const usersBefore = (await q('select count(*)::int as n from users'))[0]!.n;
    const uploadsBefore = (await q('select count(*)::int as n from portal_uploads'))[0]!.n;
    const nothingLeft = async () => {
      assert.equal((await q('select count(*)::int as n from schools'))[0]!.n, schoolsBefore, 'a half-built school was left behind');
      assert.equal((await q('select count(*)::int as n from users'))[0]!.n, usersBefore);
      assert.equal((await q('select count(*)::int as n from portal_uploads'))[0]!.n, uploadsBefore, 'orphan photos were left behind');
    };

    await check('a damaged file is refused and leaves nothing behind', async () => {
      await assert.rejects(() => restoreSchool({ actorUserId: Number(admin!.id), file: exported.file.subarray(0, 200), code: 'X' + suffix }), /not a valid EduCBT/);
      await nothingLeft();
    });
    await check('a tampered file is refused and leaves nothing behind', async () => {
      const doc = decode(exported.file); doc.tables.students![0]!.first_name = 'Hacked';
      await assert.rejects(() => restoreSchool({ actorUserId: Number(admin!.id), file: encode(doc), code: 'X' + suffix }), /integrity check/);
      await nothingLeft();
    });
    await check('a school code that already exists fails and rolls back EVERYTHING (all-or-nothing)', async () => {
      await assert.rejects(() => restoreSchool({ actorUserId: Number(admin!.id), file: exported.file, code: A.code }));
      await nothingLeft();
    });
    await check('a file whose links are broken is refused midway and rolls back EVERYTHING', async () => {
      const { buildDocument } = await import('@/lib/school-backup/format');
      const doc = decode(exported.file);
      const broken = buildDocument({ createdAt: doc.createdAt, app: doc.app, credentials: doc.credentials, school: doc.school, uploads: doc.uploads,
        tables: { ...doc.tables, enrollments: doc.tables.enrollments!.map((e) => ({ ...e, class_id: 999999 })) } });
      await assert.rejects(() => restoreSchool({ actorUserId: Number(admin!.id), file: encode(broken), code: 'Y' + suffix }), /not in the backup/);
      await nothingLeft();
    });
    await check('a backup with no principal is refused', async () => {
      const { buildDocument } = await import('@/lib/school-backup/format');
      const doc = decode(exported.file);
      const noPrincipal = buildDocument({ createdAt: doc.createdAt, app: doc.app, credentials: doc.credentials, school: doc.school, uploads: doc.uploads,
        tables: { ...doc.tables, users: doc.tables.users!.filter((u) => u.role !== 'principal') } });
      await assert.rejects(() => restoreSchool({ actorUserId: Number(admin!.id), file: encode(noPrincipal), code: 'Z' + suffix }), /no principal/);
      await nothingLeft();
    });
    await check('deferred mode (background job): NO password is generated or stored for the principal', async () => {
      const d = await restoreSchool({ actorUserId: Number(admin!.id), file: exported.file, code: 'D' + suffix, subdomain: ('d' + suffix).toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(d.school.id);
      assert.equal(d.temporaryPassword, null);
      const [p] = await q(`select password_hash, must_change_password from users where school_id = $1 and role = 'principal'`, [d.school.id]);
      assert.ok(String(p!.password_hash).startsWith('!restored-no-password!'), 'principal must have no usable password until one is issued');
      assert.equal(p!.must_change_password, true);
    });
    await check('the same backup can be restored twice (two independent copies)', async () => {
      const again = await restoreSchool({ actorUserId: Number(admin!.id), file: exported.file, code: 'M' + suffix, subdomain: ('m' + suffix).toLowerCase() });
      schoolIds.push(again.school.id);
      assert.notEqual(again.school.id, NEW);
      assert.notEqual(
        (await q(`select photo_url from students where school_id = $1`, [again.school.id]))[0]!.photo_url,
        (await q(`select photo_url from students where school_id = $1`, [NEW]))[0]!.photo_url, 'two copies must not share a photo token');
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from users where id = ${admin!.id}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end({ timeout: 2 }).catch(() => {});
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
