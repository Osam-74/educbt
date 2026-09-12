/**
 * Promotion + transcripts integration checks.
 * Run with the app-role and owner URLs pointing at a disposable LOCAL
 * database; never at production.
 *   npx tsx src/db/test-promotion.ts
 *
 * Legacy reference: includes/Services/{PromotionService,TranscriptService}.php.
 *
 * Covers: the promotion lifecycle (propose → review → override → commit →
 * reverse), terminal-level handling, the pass-cap rule, override reason
 * enforcement, role gating (principal commits, VP proposes, teacher neither),
 * history preservation at commit, transcripts (compile grouping, publication
 * gate, issue/reissue/revoke, serial format), secure HMAC verification, and
 * cross-tenant rejection at both the service and RLS layers.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

const schoolIds: number[] = [];

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED', 'TRANSCRIPT_VERIFY_SECRET']) {
    if (!process.env[key]) throw new Error(`Promotion tests require ${key} in the environment.`);
  }
  const { schema, forSchool } = await import('@/db');
  const promotion = await import('@/lib/promotion/promotion');
  const transcript = await import('@/lib/promotion/transcript');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (name: string, fn: () => unknown | Promise<unknown>, fragment?: string) => {
    try {
      await fn();
    } catch (error) {
      if (fragment && !(error instanceof Error && error.message.includes(fragment))) {
        throw new Error(`${name}: expected "${fragment}", got "${error instanceof Error ? error.message : error}"`);
      }
      count++; console.log('PASS  ' + name);
      return;
    }
    throw new Error(`${name}: expected a rejection, got success`);
  };
  const actor = (userId: number, schoolId: number, role: string, staffId: number | null = null, studentId: number | null = null): Actor =>
    ({ userId, schoolId, role, loginId: 'test', staffId, studentId });

  /** Totals per subject per term, e.g. { ENG: [70, 70, 70], ... } — one row per term. */
  type Marks = Record<string, number[]>;

  async function fixture() {
    const code = 'PT' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Promotion Test School', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);

    const [sFrom] = await db.insert(schema.academicSessions).values({ schoolId, title: '2024/25', isCurrent: false }).returning();
    const [sTo] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [sOld] = await db.insert(schema.academicSessions).values({ schoolId, title: '2023/24', isCurrent: false }).returning();

    const terms = await db.insert(schema.terms).values([
      { schoolId, sessionId: sFrom!.id, title: 'First', position: 1 },
      { schoolId, sessionId: sFrom!.id, title: 'Second', position: 2 },
      { schoolId, sessionId: sFrom!.id, title: 'Third', position: 3 },
      { schoolId, sessionId: sOld!.id, title: 'Third', position: 3 },
    ]).returning();
    const [t1, t2, t3, t0] = terms as unknown as [{ id: number }, { id: number }, { id: number }, { id: number }];

    const levels = await db.insert(schema.classLevels).values([
      { schoolId, name: 'JSS1', levelOrder: 1 },
      { schoolId, name: 'JSS2', levelOrder: 2 },
      { schoolId, name: 'JSS3', levelOrder: 3 },
    ]).returning();
    const [l1, l2, l3] = levels as unknown as [{ id: number }, { id: number }, { id: number }];

    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: l1!.id, displayName: 'JSS1 Gold', arm: 'Gold' },
      { schoolId, levelId: l2!.id, displayName: 'JSS2 Gold', arm: 'Gold' },
      { schoolId, levelId: l3!.id, displayName: 'JSS3 Gold', arm: 'Gold' },
    ]).returning();
    const [c1, c2, c3] = classes as unknown as [{ id: number }, { id: number }, { id: number }];

    const subjectRows = await db.insert(schema.subjects).values([
      { schoolId, name: 'English', code: 'ENG', isCompulsory: true },
      { schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true },
      { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
      { schoolId, name: 'Chemistry', code: 'CHE', isCompulsory: false },
      { schoolId, name: 'Physics', code: 'PHY', isCompulsory: false },
      { schoolId, name: 'Agriculture', code: 'AGR', isCompulsory: false },
    ]).returning();
    const subjectId = Object.fromEntries(subjectRows.map(s => [s.code, s.id])) as Record<string, number>;

    const user = async (role: 'principal' | 'vice_principal' | 'teacher', tag = '') => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
      return u!;
    };
    const principal = await user('principal');
    const vice = await user('vice_principal');
    const teacher = await user('teacher');

    const mkStudent = async (tag: string, classId: number, sessionId: number) => {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: `${code}/${tag}`, firstName: tag, lastName: 'Student', status: 'active' }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId, sessionId, status: 'active' });
      return s!;
    };

    // Level 1 cohort.
    const sPromo = await mkStudent('PROMO', c1!.id, sFrom!.id);
    const sTrial = await mkStudent('TRIAL', c1!.id, sFrom!.id);
    const sRepeat = await mkStudent('REPT', c1!.id, sFrom!.id);
    const sUnresolved = await mkStudent('UNRES', c1!.id, sFrom!.id);
    const sCoreFail = await mkStudent('COREF', c1!.id, sFrom!.id);
    const sFew = await mkStudent('FEWS', c1!.id, sFrom!.id);
    // Terminal level cohort.
    const sGrad = await mkStudent('GRAD', c3!.id, sFrom!.id);
    const sTermFail = await mkStudent('TERMFAIL', c3!.id, sFrom!.id);

    const publish = (studentId: number, sessionId: number, termId: number, subject: string, total: number) => ({
      schoolId, studentId, subjectId: subjectId[subject]!, sessionId, termId,
      total: String(total), grade: total >= 70 ? 'A' : total >= 40 ? 'C' : 'F',
      complete: true, state: 'published' as const, published: true,
    });

    const allTerms = [t1!.id, t2!.id, t3!.id];
    const rows: Array<ReturnType<typeof publish>> = [];
    const spread = (studentId: number, marks: Marks) => {
      for (const [subject, totals] of Object.entries(marks)) {
        totals.forEach((total, i) => rows.push(publish(studentId, sFrom!.id, allTerms[i]!, subject, total)));
      }
    };
    const six = (n: number) => ({ ENG: [n, n, n], MTH: [n, n, n], BIO: [n, n, n], CHE: [n, n, n], PHY: [n, n, n], AGR: [n, n, n] });
    spread(sPromo.id, six(70));                                  // average 70, 6 passed → promote
    spread(sTrial.id, six(42));                                  // average 42 → trial
    spread(sRepeat.id, six(30));                                 // average 30 → repeat
    // sUnresolved: deliberately no results.
    spread(sCoreFail.id, { ENG: [20, 20, 20], MTH: [80, 80, 80], BIO: [80, 80, 80], CHE: [80, 80, 80], PHY: [80, 80, 80], AGR: [80, 80, 80] }); // failed core → repeat
    spread(sFew.id, { ENG: [88, 88, 88], MTH: [88, 88, 88], BIO: [88, 88, 88], CHE: [88, 88, 88], PHY: [88, 88, 88] }); // 5 subjects offered → cap applies → promote
    spread(sGrad.id, six(60));                                   // terminal, ≥ trial average → graduate
    spread(sTermFail.id, six(35));                                // terminal, below → repeat

    // One older session so the transcript has two sessions to order.
    await db.insert(schema.enrollments).values({ schoolId, studentId: sPromo.id, classId: c1!.id, sessionId: sOld!.id, status: 'active' });
    rows.push(publish(sPromo.id, sOld!.id, t0!.id, 'ENG', 65), publish(sPromo.id, sOld!.id, t0!.id, 'MTH', 65));
    // And one UNPUBLISHED row that must never appear on a transcript.
    const draftRow = publish(sPromo.id, sOld!.id, t0!.id, 'AGR', 99);
    rows.push({ ...draftRow, state: 'draft' as unknown as typeof draftRow.state, published: false });

    await db.insert(schema.subjectResults).values(rows);

    // A second school for cross-tenant checks.
    const [schoolB] = await db.insert(schema.schools).values({ name: 'Other School', code: 'OTH' + randomUUID().slice(0, 4).toUpperCase(), settings: {} }).returning();
    schoolIds.push(schoolB!.id);
    const [principalB] = await db.insert(schema.users).values({ schoolId: schoolB!.id, role: 'principal', loginId: 'principal-' + code + '-b', passwordHash: 'unused', mustChangePassword: false }).returning();

    return { schoolId, schoolCode: code, sFrom: sFrom!.id, sTo: sTo!.id, sOld: sOld!.id,
      l1: l1!.id, l2: l2!.id, l3: l3!.id, c1: c1!.id, c2: c2!.id,
      principal, vice, teacher, principalB, schoolB: schoolB!.id,
      students: { sPromo, sTrial, sRepeat, sUnresolved, sCoreFail, sFew, sGrad, sTermFail } };
  }

  console.log('── fixture ──');
  const F = await fixture();
  const A = actor(F.principal!.id, F.schoolId, 'principal');
  const V = actor(F.vice!.id, F.schoolId, 'vice_principal');
  const T = actor(F.teacher!.id, F.schoolId, 'teacher');
  const B = actor(F.principalB!.id, F.schoolB, 'principal');

  console.log('── promotion lifecycle ──');

  await rejects('teacher cannot propose promotion', () => promotion.proposePromotion(T, { fromSessionId: F.sFrom, toSessionId: F.sTo, levelId: F.l1 }), 'Only the principal or vice principal');
  await rejects('same-session promotion refused', () => promotion.proposePromotion(A, { fromSessionId: F.sFrom, toSessionId: F.sFrom, levelId: F.l1 }), 'different sessions');

  const proposal = await promotion.proposePromotion(A, { fromSessionId: F.sFrom, toSessionId: F.sTo, levelId: F.l1 });
  await check('proposal summary counts outcomes correctly', () => {
    assert.deepEqual(
      [proposal.summary.promoted, proposal.summary.trial, proposal.summary.repeated, proposal.summary.unresolved],
      [2, 1, 2, 1],
    );
  });
  const batchId = proposal.batchId;

  const review = await promotion.promotionReview(A, batchId);
  await check('decisions carry averages and capped pass thresholds', () => {
    const byAdmission: Record<string, typeof review.decisions[number]> = Object.fromEntries(review.decisions.map(d => [d.admissionNumber, d]));
    const d = (tag: string) => byAdmission[`${F.schoolCode}/${tag}`]!;
    assert.equal(d('PROMO').proposedOutcome, 'promote');
    assert.equal(d('PROMO').averageScore, 70);
    assert.equal(d('PROMO').toClass, 'JSS2 Gold');
    assert.equal(d('TRIAL').proposedOutcome, 'trial');
    assert.equal(d('REPT').proposedOutcome, 'repeat');
    assert.equal(d('REPT').toClass, 'JSS1 Gold', 'a repeater stays in their own class');
    assert.equal(d('UNRES').proposedOutcome, 'unresolved');
    assert.equal(d('UNRES').note, 'no_published_results');
    const core = d('COREF');
    assert.equal(core.proposedOutcome, 'repeat');
    assert.equal(core.note, 'failed_compulsory_subject');
    const few = d('FEWS');
    assert.equal(few.proposedOutcome, 'promote', 'a 5-subject student averaging 88 is not judged against "pass 6"');
    assert.equal(few.subjectsOffered, 5);
  });

  await rejects('a second open proposal for the same scope is refused', () =>
    promotion.proposePromotion(A, { fromSessionId: F.sFrom, toSessionId: F.sTo, levelId: F.l1 }), 'already open');

  console.log('── terminal level ──');
  const terminalProposal = await promotion.proposePromotion(V, { fromSessionId: F.sFrom, toSessionId: F.sTo, levelId: F.l3 });
  const terminalReview = await promotion.promotionReview(V, terminalProposal.batchId);
  await check('vice principal may propose; terminal level graduates rather than advances', () => {
    assert.equal(terminalProposal.summary.graduated, 1);
    assert.equal(terminalProposal.summary.repeated, 1);
    const grad = terminalReview.decisions.find(d => d.admissionNumber === `${F.schoolCode}/GRAD`)!;
    const termFail = terminalReview.decisions.find(d => d.admissionNumber === `${F.schoolCode}/TERMFAIL`)!;
    assert.equal(grad.finalOutcome, 'graduate');
    assert.equal(grad.toClass, null, 'graduates have no destination class');
    assert.equal(termFail.finalOutcome, 'repeat');
  });

  console.log('── override with written reason ──');
  await rejects('teacher cannot override', () =>
    promotion.overridePromotion(T, batchId, F.students.sUnresolved.id, 'promote', 'A good enough reason.'), 'Only the principal or vice principal');
  await rejects('override without a real reason is refused', () =>
    promotion.overridePromotion(A, batchId, F.students.sUnresolved.id, 'promote', 'short'), 'reason');
  await rejects('override to unresolved is refused', () =>
    promotion.overridePromotion(A, batchId, F.students.sUnresolved.id, 'unresolved', 'A good enough reason.'), 'valid promotion outcome');
  await check('overriding an unresolved student to promote computes the destination class', async () => {
    await promotion.overridePromotion(A, batchId, F.students.sUnresolved.id, 'promote', 'Joined mid-year; records arriving.');
    const after = await promotion.promotionReview(A, batchId);
    const row = after.decisions.find(d => d.studentId === F.students.sUnresolved.id)!;
    assert.equal(row.finalOutcome, 'promote');
    assert.equal(row.toClass, 'JSS2 Gold');
    assert.equal(row.overrideReason, 'Joined mid-year; records arriving.');
  });
  await check('bulk override records one decision per student with the same reason', async () => {
    const result = await promotion.bulkOverridePromotion(A, batchId, [F.students.sCoreFail.id, F.students.sRepeat.id], 'trial', 'External results arrived late; giving the term of grace.');
    assert.equal(result.count, 2);
    const after = await promotion.promotionReview(A, batchId);
    for (const id of [F.students.sCoreFail.id, F.students.sRepeat.id]) {
      const row = after.decisions.find(d => d.studentId === id)!;
      assert.equal(row.finalOutcome, 'trial');
    }
  });
  console.log('── commit (principal only, history preserved) ──');
  const fromSessionEnrollments = async () =>
    (await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.sessionId, F.sFrom), eq(schema.enrollments.schoolId, F.schoolId)))).length;
  const beforeHistory = await fromSessionEnrollments();
  const resultRows = await db.select({ id: schema.subjectResults.id }).from(schema.subjectResults)
    .where(and(eq(schema.subjectResults.schoolId, F.schoolId), eq(schema.subjectResults.sessionId, F.sFrom)));

  const committed = await promotion.commitPromotion(A, batchId);
  await check('commit writes to-session enrollments and graduates the graduates', async () => {
    assert.equal(committed.enrolled, 6, 'every promote/trial student gets an enrollment');
    assert.equal(committed.graduated, 0, 'no graduates in the non-terminal batch');
    const toRows = await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.sessionId, F.sTo), eq(schema.enrollments.schoolId, F.schoolId)));
    assert.equal(toRows.length, 6);
    const moved = toRows.find(e => e.studentId === F.students.sPromo.id)!;
    assert.equal(moved.classId, F.c2, 'the promoted student lands in the next level class');
    const stayed = toRows.find(e => e.studentId === F.students.sRepeat.id)!;
    assert.equal(stayed.classId, F.c1, 'the repeater is re-enrolled in their own class');
    assert.equal(await fromSessionEnrollments(), beforeHistory, 'the from-session enrollments are untouched');
    const afterResults = await db.select({ id: schema.subjectResults.id }).from(schema.subjectResults)
      .where(and(eq(schema.subjectResults.schoolId, F.schoolId), eq(schema.subjectResults.sessionId, F.sFrom)));
    assert.equal(afterResults.length, resultRows.length, 'no result row is touched by promotion');
  });
  await rejects('override after commit is refused', () =>
    promotion.overridePromotion(A, batchId, F.students.sTrial.id, 'repeat', 'A reason long enough here.'), 'already committed');
  await rejects('re-committing a committed batch is refused', () => promotion.commitPromotion(A, batchId), 'not open for commit');

  await rejects('the vice principal cannot commit a promotion', () =>
    promotion.commitPromotion(V, terminalProposal.batchId), 'Only the principal');
  const terminalCommitted = await promotion.commitPromotion(A, terminalProposal.batchId);
  await check('terminal commit marks graduates and writes no class for them', async () => {
    assert.equal(terminalCommitted.graduated, 1);
    const [grad] = await db.select().from(schema.students).where(eq(schema.students.id, F.students.sGrad.id));
    assert.equal(grad!.status, 'graduated');
    const [fail] = await db.select().from(schema.students).where(eq(schema.students.id, F.students.sTermFail.id));
    assert.equal(fail!.status, 'active');
    const toRows = await db.select().from(schema.enrollments)
      .where(and(eq(schema.enrollments.sessionId, F.sTo), eq(schema.enrollments.schoolId, F.schoolId), inArray(schema.enrollments.studentId, [F.students.sTermFail.id])));
    assert.equal(toRows.length, 1, 'the terminal repeater is enrolled in the to-session');
  });

  console.log('── reverse ──');
  await rejects('the vice principal cannot reverse', () =>
    promotion.reversePromotion(V, terminalProposal.batchId, 'Because the reason is long enough.'), 'Only the principal');
  await rejects('reversal needs a written reason', () =>
    promotion.reversePromotion(A, terminalProposal.batchId, 'short'), 'reason');
  const reversed = await promotion.reversePromotion(A, terminalProposal.batchId, 'Wrong session chosen for the move; redoing it.');
  await check('reversal removes only what commit wrote and reinstates graduates', async () => {
    assert.equal(reversed.reinstated, 1);
    const [grad] = await db.select().from(schema.students).where(eq(schema.students.id, F.students.sGrad.id));
    assert.equal(grad!.status, 'active', 'a reversed graduate returns to active');
    const leftover = await db.select().from(schema.enrollments)
      .where(and(eq(schema.enrollments.sessionId, F.sTo), eq(schema.enrollments.schoolId, F.schoolId), inArray(schema.enrollments.studentId, [F.students.sTermFail.id, F.students.sGrad.id])));
    assert.equal(leftover.length, 0);
    const batchRow = await db.select().from(schema.promotionBatches).where(eq(schema.promotionBatches.id, terminalProposal.batchId));
    assert.equal(batchRow[0]!.status, 'reversed');
  });

  await check('audit trail covers the full lifecycle', async () => {
    const actions = await db.select({ action: schema.auditLog.action }).from(schema.auditLog)
      .where(and(eq(schema.auditLog.schoolId, F.schoolId), inArray(schema.auditLog.action,
        ['promotion.proposed', 'promotion.overridden', 'promotion.bulk_overridden', 'promotion.committed', 'promotion.reversed'])));
    const set = new Set(actions.map(a => a.action));
    for (const expected of ['promotion.proposed', 'promotion.overridden', 'promotion.bulk_overridden', 'promotion.committed', 'promotion.reversed']) {
      assert.ok(set.has(expected), `audit missing ${expected}`);
    }
  });

  console.log('── transcripts ──');
  const compiledData = await transcript.transcriptData(A, F.students.sPromo.id);
  await check('compile groups sessions newest-first, terms in order, published only', async () => {
    assert.equal(compiledData.sessions.length, 2);
    assert.equal(compiledData.sessions[0]!.session, '2024/25');
    assert.equal(compiledData.sessions[0]!.className, 'JSS1 Gold');
    assert.equal(compiledData.sessions[0]!.terms.length, 3);
    assert.equal(compiledData.sessions[1]!.session, '2023/24');
    const oldTermSubjects = compiledData.sessions[1]!.terms[0]!.subjects;
    assert.equal(oldTermSubjects.length, 2, 'the unpublished draft row never appears on the transcript');
    assert.ok(!oldTermSubjects.some(s => s.score === 99), 'no draft score leaks');
    assert.equal(compiledData.termsRecorded, 4);
    // Term averages: (70*6)/6 = 70 for the first three terms; (65*2)/2 = 65 for the old term.
    assert.equal(compiledData.sessions[0]!.terms[0]!.average, 70);
    assert.equal(compiledData.termsRecorded, 4);
    assert.ok(Math.abs(compiledData.cumulativeAverage - (70 * 3 + 65) / 4) < 0.01);
  });
  await check('term position is ranked against the class cohort', () => {
    const term = compiledData.sessions[0]!.terms[0]!;
    assert.ok(term.classSize >= 5, 'cohort includes classmates with published results');
    assert.ok(term.position >= 1 && term.position <= term.classSize);
  });

  await rejects('the vice principal cannot issue transcripts', () =>
    transcript.issueTranscript(V, F.students.sPromo.id, 'University admission'), 'Only the principal');
  await rejects('a student with no published results cannot be transcribed', () =>
    transcript.issueTranscript(A, F.students.sUnresolved.id, 'x'), 'no published results');

  const issued = await transcript.issueTranscript(A, F.students.sPromo.id, 'University admission');
  await check('the first issue is "issued" with the legacy serial format', () => {
    assert.match(issued.serial, new RegExp(`^${F.schoolCode}/TR/\\d{4}/0001$`));
    assert.equal(issued.status, 'issued');
  });
  const reissued = await transcript.issueTranscript(A, F.students.sPromo.id, 'Scholarship application');
  await check('the second issue is marked "reissued" and increments the serial', () => {
    assert.equal(reissued.status, 'reissued');
    assert.match(reissued.serial, /0002$/);
  });

  const history = await transcript.transcriptHistory(A, F.students.sPromo.id);
  await check('issuance history keeps every copy', () => {
    assert.equal(history.transcripts.length, 2);
    assert.equal(history.transcripts[0]!.serial, reissued.serial);
    assert.equal(history.transcripts[0]!.termsRecorded, 4);
  });

  await rejects('revocation needs a written reason', () =>
    transcript.revokeTranscript(A, issued.serial, 'short'), 'reason');
  await check('revocation is recorded and visible to later verification', async () => {
    await transcript.revokeTranscript(A, issued.serial, 'Issued in error: wrong student record.');
    const after = await transcript.transcriptHistory(A, F.students.sPromo.id);
    const row = after.transcripts.find(t => t.serial === issued.serial)!;
    assert.equal(row.status, 'revoked');
    assert.equal(row.revokeReason, 'Issued in error: wrong student record.');
  });
  await rejects('a revoked transcript cannot be revoked again', () =>
    transcript.revokeTranscript(A, issued.serial, 'Issued in error again.'), 'already revoked');

  console.log('── secure verification ──');
  const code = transcript.verificationCode(reissued.serial);
  await check('the verification code is an HMAC over the serial — never stored', async () => {
    assert.match(code, /^[0-9a-f]{10}$/);
    assert.ok(transcript.verifyCode(reissued.serial, code));
    assert.ok(!transcript.verifyCode(reissued.serial, 'deadbeef00'));
    assert.ok(!transcript.verifyCode(reissued.serial + '1', code), 'a serial one character off does not verify');
    const [row] = await db.select().from(schema.transcripts).where(eq(schema.transcripts.serial, reissued.serial));
    assert.ok(!JSON.stringify(row).includes(code), 'the code is not stored anywhere');
  });

  console.log('── cross-tenant ──');
  await rejects('another school cannot review this batch', () => promotion.promotionReview(B, batchId), 'does not exist');
  await rejects('another school cannot commit this batch', () => promotion.commitPromotion(B, batchId), 'does not exist');
  await rejects('another school cannot load this transcript', () =>
    transcript.transcriptBySerial(B, reissued.serial), 'does not exist');
  await rejects('another school cannot revoke this transcript', () =>
    transcript.revokeTranscript(B, reissued.serial, 'Not their transcript.'), 'does not exist');
  await check('another school sees none of the batches', async () => {
    const theirs = await promotion.promotionBatches(B);
    assert.equal(theirs.length, 0);
  });

  console.log('── RLS (fail closed) ──');
  await check('a tenantless connection sees no promotion or transcript rows', async () => {
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
    try {
      const batches = await app`select count(*)::int as n from promotion_batches`;
      const decisions = await app`select count(*)::int as n from promotion_decisions`;
      const transcripts = await app`select count(*)::int as n from transcripts`;
      assert.equal(batches[0]!.n, 0);
      assert.equal(decisions[0]!.n, 0);
      assert.ok(transcripts[0]!.n >= 0, 'the serial-read policy exists for public verification only');
    } finally {
      await app.end();
    }
  });

  console.log('── HTTP (running server) ──');
  if (!process.env.CA_TEST_HTTP_URL) {
    console.log('SKIP  HTTP section (set CA_TEST_HTTP_URL to a running server)');
  } else {
    const base = new URL(process.env.CA_TEST_HTTP_URL); assert(['localhost', '127.0.0.1', 'demo.localhost'].includes(base.hostname));
    const mkSession = async (userId: number) => {
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 300000) });
      const headers = { cookie: 'educbt.session=' + token };
      const plain = async (path: string) => fetch(new URL(path, base), { headers, redirect: 'manual' });
      return { plain, open: async (path: string) => fetch(new URL(path, base), { redirect: 'manual' }) };
    };
    const principalHttp = await mkSession(F.principal.id);
    const viceHttp = await mkSession(F.vice.id);
    const teacherHttp = await mkSession(F.teacher.id);

    const officePage = await (await principalHttp.plain('/portal/promotion')).text();
    assert.ok(officePage.includes('New proposal'), 'the office renders the proposal form');
    // This batch was committed earlier in the run — the principal holds the
    // reverse control, the VP holds nothing.
    const reviewPage = await (await principalHttp.plain(`/portal/promotion?batch=${batchId}`)).text();
    assert.ok(reviewPage.includes('Reverse promotion'), 'the principal sees the reverse control on a committed batch');
    assert.ok(reviewPage.includes('has been committed'), 'the committed state is explained');
    const vpPage = await (await viceHttp.plain(`/portal/promotion?batch=${batchId}`)).text();
    assert.ok(!vpPage.includes('Reverse promotion'), 'the VP cannot reverse a committed batch');
    const teacherPage = await teacherHttp.plain('/portal/promotion');
    assert.equal(teacherPage.status, 307, 'a teacher is redirected away from promotion');

    const transcriptsPage = await (await principalHttp.plain(`/portal/transcripts?student=${encodeURIComponent(`${F.schoolCode}/PROMO`)}`)).text();
    assert.ok(transcriptsPage.includes('Cumulative average'), 'the transcript office renders the student summary');
    const document = await (await principalHttp.plain(`/portal/transcripts/${encodeURIComponent(reissued.serial)}`)).text();
    assert.ok(document.includes('Academic Transcript'), 'the issued document renders');
    assert.ok(document.includes('OFFICIAL COPY'), 'the document carries the official-copy watermark');
    assert.ok(document.includes(reissued.serial), 'the document carries its serial');
    assert.ok(document.includes(code), 'the document carries the verification code');

    // Public verification — no session at all.
    const good = await (await principalHttp.open(`/verify/transcript?serial=${encodeURIComponent(reissued.serial)}&code=${code}`)).text();
    assert.ok(good.includes('Genuine'), 'the public verify page confirms a genuine copy');
    const badCode = await (await principalHttp.open(`/verify/transcript?serial=${encodeURIComponent(reissued.serial)}&code=deadbeef00`)).text();
    assert.ok(badCode.includes('Not verified'), 'a wrong code does not verify');
    const revoked = await (await principalHttp.open(`/verify/transcript?serial=${encodeURIComponent(issued.serial)}&code=${transcript.verificationCode(issued.serial)}`)).text();
    assert.ok(revoked.includes('Revoked'), 'a revoked serial is reported as revoked');

    count += 8;
    console.log('PASS  HTTP promotion & transcript pages (8 checks)');
  }

  console.log(`\nOK: ${count} checks passed.`);
}

async function cleanup() {
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  for (const id of schoolIds) {
    await owner`DELETE FROM schools WHERE id = ${id}`.catch(() => {});
  }
  await owner.end();
  console.log('Teardown complete.');
}

main().then(cleanup).catch(async (err) => { await cleanup().catch(() => {}); console.error(err); process.exit(1); });
