/**
 * Student promotion (legacy EduCBT Pro parity).
 *
 * Legacy reference: includes/Services/PromotionService.php — a rule-driven
 * BATCH with human review. The proposal is stored, not applied; a human
 * reviews counts and exceptions, overrides individuals with a written reason,
 * and only the PRINCIPAL commits. Every decision — proposed and final — is
 * kept so "why was my child not promoted" has an answer on file.
 *
 * What is deliberately preserved from the legacy engine:
 *   - three outcomes plus graduate/unresolved (promote / trial / repeat);
 *   - the annual average is taken across ALL published terms in the session,
 *     never just the third;
 *   - the subjects-passed threshold is CAPPED at the number the student
 *     actually offers (legacy's first version silently demoted a 5-subject
 *     student averaging 88% to trial);
 *   - English and Mathematics are compulsory to pass;
 *   - a terminal level (JSS3/SS3 — here: the highest level_order in the school)
 *     graduates rather than advances;
 *   - no published results means UNRESOLVED, never a guessed outcome;
 *   - commit refuses to run while any student is unresolved or has no
 *     destination class — both silently lose a child from the roll;
 *   - commit is idempotent per student (one enrollment per student per session)
 *     and reversible with a reason.
 *
 * What is NOT copied: wp_options rules storage. The ruleset is validated,
 * snapshotted onto the batch, and audited — a later rules change cannot make
 * an old batch unexplainable. The terminal/next level is DERIVED from
 * level_order rather than stored flags: the existing level structure is the
 * source of truth, and a stored "next_level_id" would be a second copy of
 * something the ordering already says.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';

export class PromotionError extends Error {}
const fail = (message: string): never => { throw new PromotionError(message); };

/** Legacy: RUN_PROMOTION belongs to the principal and vice principal only —
 *  not the exam officer. COMMIT_PROMOTION is the principal's alone. */
export const PROMOTION_RUNNERS = ['principal', 'vice_principal'] as const;

export function canRunPromotion(actor: Actor): boolean {
  return (PROMOTION_RUNNERS as readonly string[]).includes(actor.role);
}

export function canCommitPromotion(actor: Actor): boolean {
  return actor.role === 'principal';
}

export const promotionRulesSchema = z.object({
  passMark: z.number().min(0).max(100).default(40),
  promoteAverage: z.number().min(0).max(100).default(45),
  trialAverage: z.number().min(0).max(100).default(40),
  minSubjectsPassed: z.number().int().min(1).max(20).default(6),
  mustPassCodes: z.array(z.string().trim().min(1).max(20)).max(10).default(['ENG', 'MTH', 'ENG-J', 'MTH-J']),
  requireCore: z.boolean().default(true),
}).strict();

export type PromotionRules = z.infer<typeof promotionRulesSchema>;

export function defaultRules(): PromotionRules {
  return promotionRulesSchema.parse({});
}

const proposeSchema = z.object({
  fromSessionId: z.number().int().positive(),
  toSessionId: z.number().int().positive(),
  levelId: z.number().int().positive(),
  rules: promotionRulesSchema.optional(),
}).strict();

export type PromotionOutcome = 'promote' | 'trial' | 'repeat' | 'graduate' | 'unresolved';

const OVERRIDEABLE: PromotionOutcome[] = ['promote', 'trial', 'repeat', 'graduate'];

export type PromotionDecisionRow = {
  studentId: number;
  name: string;
  admissionNumber: string;
  fromClassId: number | null;
  toClassId: number | null;
  proposedOutcome: PromotionOutcome;
  finalOutcome: PromotionOutcome;
  averageScore: number;
  subjectsPassed: number;
  subjectsOffered: number;
  note: string;
  overrideReason: string;
};

export type PromotionBatch = typeof schema.promotionBatches.$inferSelect;

/** All levels of the school ordered by level_order. The next level is the first
 *  with a strictly greater order; its absence marks the terminal level. */
async function levelsOrdered(tx: Tx, schoolId: number) {
  return tx.select({ id: schema.classLevels.id, name: schema.classLevels.name, levelOrder: schema.classLevels.levelOrder })
    .from(schema.classLevels)
    .where(eq(schema.classLevels.schoolId, schoolId))
    .orderBy(asc(schema.classLevels.levelOrder));
}

/** The class a promoted student joins: keep the arm and department where the
 *  next level offers them, else any class at that level (legacy target_class). */
async function targetClass(tx: Tx, schoolId: number, nextLevelId: number, arm: string | null, departmentId: number | null): Promise<number | null> {
  const rows = await tx.select({ id: schema.classes.id, departmentId: schema.classes.departmentId, arm: schema.classes.arm })
    .from(schema.classes)
    .where(and(eq(schema.classes.schoolId, schoolId), eq(schema.classes.levelId, nextLevelId), eq(schema.classes.status, 'active')))
    .orderBy(asc(schema.classes.arm));
  if (!rows.length) return null;
  if (arm) {
    const sameArmDept = rows.find(r => r.arm === arm && (departmentId === null ? r.departmentId === null : r.departmentId === departmentId));
    if (sameArmDept) return sameArmDept.id;
    const sameArm = rows.find(r => r.arm === arm);
    if (sameArm) return sameArm.id;
  }
  return rows[0]!.id;
}

type Evaluation = {
  studentId: number;
  firstName: string;
  lastName: string;
  admissionNumber: string;
  fromClassId: number;
  arm: string | null;
  departmentId: number | null;
  outcome: PromotionOutcome;
  toClassId: number | null;
  average: number;
  subjectsPassed: number;
  subjectsOffered: number;
  note: string;
};

/** Score every enrolled student of the level against the rules. */
async function evaluateLevel(
  tx: Tx, schoolId: number, levelId: number, sessionId: number, rules: PromotionRules,
  levels: Array<{ id: number; levelOrder: number }>, levelOrder: number,
): Promise<Evaluation[]> {
  const nextLevel = levels.find(l => l.levelOrder > levelOrder) ?? null;
  const isTerminal = !nextLevel;

  const roster = await tx.select({
    studentId: schema.enrollments.studentId,
    fromClassId: schema.enrollments.classId,
    arm: schema.classes.arm,
    departmentId: schema.classes.departmentId,
    firstName: schema.students.firstName,
    lastName: schema.students.lastName,
    admissionNumber: schema.students.admissionNumber,
  }).from(schema.enrollments)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      eq(schema.enrollments.sessionId, sessionId),
      eq(schema.enrollments.status, 'active'),
      eq(schema.classes.levelId, levelId),
    )).orderBy(asc(schema.enrollments.studentId));

  if (!roster.length) return [];

  const ids = roster.map(r => r.studentId);
  // Only PUBLISHED results may drive a promotion — an unapproved mark must
  // never move a child's whole year.
  const results = await tx.select({
    studentId: schema.subjectResults.studentId,
    subjectId: schema.subjectResults.subjectId,
    termId: schema.subjectResults.termId,
    total: schema.subjectResults.total,
    code: schema.subjects.code,
  }).from(schema.subjectResults)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.subjectResults.subjectId))
    .where(and(
      eq(schema.subjectResults.schoolId, schoolId),
      inArray(schema.subjectResults.studentId, ids),
      eq(schema.subjectResults.sessionId, sessionId),
      eq(schema.subjectResults.published, true),
    )).orderBy(asc(schema.subjectResults.id));

  const byStudent = new Map<number, typeof results>();
  for (const row of results) {
    const list = byStudent.get(row.studentId) ?? [];
    list.push(row);
    byStudent.set(row.studentId, list);
  }

  const out: Evaluation[] = [];
  for (const student of roster) {
    const rows = byStudent.get(student.studentId) ?? [];

    if (!rows.length) {
      // No published results means no defensible decision. Flag it; guessing
      // would quietly repeat or promote a child on no evidence.
      out.push({ ...student, outcome: 'unresolved', toClassId: null, average: 0, subjectsPassed: 0, subjectsOffered: 0, note: 'no_published_results' });
      continue;
    }

    // Per-term averages across published terms, then the annual average of
    // those — never a single term's work, and never a raw subject dump that a
    // 12-subject student would win by volume.
    const termTotals = new Map<number, number[]>();
    for (const row of rows) {
      const list = termTotals.get(row.termId) ?? [];
      list.push(Number(row.total));
      termTotals.set(row.termId, list);
    }
    const termAverages = [...termTotals.values()].map(list => list.reduce((s, n) => s + n, 0) / list.length);
    const average = termAverages.reduce((s, n) => s + n, 0) / termAverages.length;

    // Subject passes across the whole session (annual subject average).
    const subjectTotals = new Map<number, number[]>();
    const subjectCode = new Map<number, string>();
    for (const row of rows) {
      const list = subjectTotals.get(row.subjectId) ?? [];
      list.push(Number(row.total));
      subjectTotals.set(row.subjectId, list);
      subjectCode.set(row.subjectId, row.code.toUpperCase());
    }
    let subjectsPassed = 0;
    const byCode = new Map<string, boolean>();
    for (const [subjectId, totals] of subjectTotals) {
      const subjectAverage = totals.reduce((s, n) => s + n, 0) / totals.length;
      const passed = subjectAverage >= rules.passMark;
      byCode.set(subjectCode.get(subjectId)!, passed);
      if (passed) subjectsPassed++;
    }

    let failedCore = false;
    if (rules.requireCore) {
      for (const code of rules.mustPassCodes) {
        const status = byCode.get(code.toUpperCase());
        if (status === false) { failedCore = true; break; }
      }
    }

    const subjectsOffered = subjectTotals.size;
    const requiredPasses = Math.min(rules.minSubjectsPassed, Math.max(1, subjectsOffered));

    let outcome: PromotionOutcome;
    if (isTerminal) {
      // JSS3 and SS3 leave rather than advance.
      outcome = average >= rules.trialAverage && !failedCore ? 'graduate' : 'repeat';
    } else if (failedCore) {
      outcome = 'repeat';
    } else if (average >= rules.promoteAverage && subjectsPassed >= requiredPasses) {
      outcome = 'promote';
    } else if (average >= rules.trialAverage) {
      outcome = 'trial';
    } else {
      outcome = 'repeat';
    }

    let toClassId: number | null = null;
    if ((outcome === 'promote' || outcome === 'trial') && nextLevel) {
      toClassId = await targetClass(tx, schoolId, nextLevel.id, student.arm, student.departmentId);
    } else if (outcome === 'repeat') {
      toClassId = student.fromClassId;
    }

    out.push({
      ...student, outcome, toClassId,
      average: Math.round(average * 100) / 100,
      subjectsPassed, subjectsOffered,
      note: failedCore ? 'failed_compulsory_subject' : '',
    });
  }

  return out;
}

const countOutcome = (rows: Evaluation[], outcome: PromotionOutcome) => rows.filter(r => r.outcome === outcome).length;

/**
 * Evaluate a level for one session and store the proposal. Nothing moves.
 */
export async function proposePromotion(actor: Actor, input: unknown) {
  if (!canRunPromotion(actor)) fail('Only the principal or vice principal may run promotion.');
  const parsed = proposeSchema.safeParse(input);
  if (!parsed.success) fail('Choose a valid from-session, to-session and level.');
  const { fromSessionId, toSessionId, levelId } = parsed.data!;
  const rules = parsed.data!.rules ?? defaultRules();

  if (fromSessionId === toSessionId) fail('Promotion must move between two different sessions.');

  return forSchool(actor.schoolId, async tx => {
    const [fromSession] = await tx.select().from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.id, fromSessionId), eq(schema.academicSessions.schoolId, actor.schoolId)));
    const [toSession] = await tx.select().from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.id, toSessionId), eq(schema.academicSessions.schoolId, actor.schoolId)));
    if (!fromSession || !toSession) fail('Those sessions are not available in this school.');

    const levels = await levelsOrdered(tx, actor.schoolId);
    const level = levels.find(l => l.id === levelId);
    if (!level) fail('That level is not available in this school.');

    const [open] = await tx.select({ id: schema.promotionBatches.id }).from(schema.promotionBatches)
      .where(and(
        eq(schema.promotionBatches.schoolId, actor.schoolId),
        eq(schema.promotionBatches.fromSessionId, fromSessionId),
        eq(schema.promotionBatches.levelId, levelId),
        eq(schema.promotionBatches.status, 'proposed'),
      )).limit(1);
    if (open) fail('A proposal is already open for this level and session. Review it before proposing again.');

    const students = await evaluateLevel(tx, actor.schoolId, levelId, fromSessionId, rules, levels, level!.levelOrder);
    if (!students.length) fail('No active students are enrolled in that level for the session chosen.');

    const summary = {
      evaluated: students.length,
      promoted: countOutcome(students, 'promote'),
      trial: countOutcome(students, 'trial'),
      repeated: countOutcome(students, 'repeat'),
      graduated: countOutcome(students, 'graduate'),
      unresolved: countOutcome(students, 'unresolved'),
    };

    const [batch] = await tx.insert(schema.promotionBatches).values({
      schoolId: actor.schoolId,
      fromSessionId, toSessionId, levelId,
      rules: rules as unknown as Record<string, unknown>,
      totalEvaluated: summary.evaluated,
      totalPromoted: summary.promoted,
      totalTrial: summary.trial,
      totalRepeated: summary.repeated,
      totalGraduated: summary.graduated,
      totalUnresolved: summary.unresolved,
      status: 'proposed',
      createdBy: actor.userId,
    }).returning();

    await tx.insert(schema.promotionDecisions).values(students.map(s => ({
      schoolId: actor.schoolId,
      batchId: batch!.id,
      studentId: s.studentId,
      fromClassId: s.fromClassId,
      toClassId: s.toClassId,
      proposedOutcome: s.outcome,
      finalOutcome: s.outcome,
      averageScore: String(s.average),
      subjectsPassed: s.subjectsPassed,
      subjectsOffered: s.subjectsOffered,
      note: s.note,
    })));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'promotion.proposed', entityType: 'promotion_batch',
      before: null,
      after: { batchId: batch!.id, fromSessionId, toSessionId, levelId, rules, summary },
    });

    return { batchId: batch!.id, summary };
  });
}

/** Resolve the destination class for a promoted student at override time —
 *  an unresolved student has no stored destination until a human chooses one. */
async function destinationFor(tx: Tx, schoolId: number, outcome: PromotionOutcome, fromClassId: number | null, toClassId: number | null): Promise<number | null> {
  if (outcome === 'repeat') return fromClassId;
  if (outcome !== 'promote' && outcome !== 'trial') return null;
  if (toClassId) return toClassId;
  if (!fromClassId) return null;
  const [fromClass] = await tx.select().from(schema.classes).where(eq(schema.classes.id, fromClassId));
  if (!fromClass) return null;
  const levels = await levelsOrdered(tx, schoolId);
  const current = levels.find(l => l.id === fromClass.levelId);
  const next = levels.find(l => l.levelOrder > (current?.levelOrder ?? -1)) ?? null;
  return next ? targetClass(tx, schoolId, next.id, fromClass.arm, fromClass.departmentId) : null;
}

async function loadBatch(tx: Tx, schoolId: number, batchId: number): Promise<PromotionBatch> {
  const [batch] = await tx.select().from(schema.promotionBatches)
    .where(and(eq(schema.promotionBatches.id, batchId), eq(schema.promotionBatches.schoolId, schoolId)));
  if (!batch) fail('That promotion batch does not exist.');
  return batch!;
}

async function applyOverride(tx: Tx, actor: Actor, batch: PromotionBatch, studentId: number, outcome: PromotionOutcome, reason: string) {
  const [decision] = await tx.select().from(schema.promotionDecisions)
    .where(and(eq(schema.promotionDecisions.batchId, batch.id), eq(schema.promotionDecisions.studentId, studentId)));
  if (!decision) fail('That student is not part of this batch.');

  const toClassId = await destinationFor(tx, actor.schoolId, outcome, decision!.fromClassId, decision!.toClassId);

  await tx.update(schema.promotionDecisions).set({
    finalOutcome: outcome,
    overrideReason: reason,
    overriddenBy: actor.userId,
    overriddenAt: new Date(),
    ...(toClassId !== decision!.toClassId ? { toClassId } : {}),
  }).where(eq(schema.promotionDecisions.id, decision!.id));

  return decision!.finalOutcome;
}

/**
 * Override one student's outcome. A reason is REQUIRED — "why was my child not
 * promoted" must be answerable from the record, not from memory.
 */
export async function overridePromotion(actor: Actor, batchId: number, studentId: number, outcome: string, reason: string) {
  if (!canRunPromotion(actor)) fail('Only the principal or vice principal may change promotion decisions.');
  if (!OVERRIDEABLE.includes(outcome as PromotionOutcome)) fail('Choose a valid promotion outcome.');
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 255) fail('Provide a written override reason of at least 10 characters.');

  return forSchool(actor.schoolId, async tx => {
    const batch = await loadBatch(tx, actor.schoolId, batchId);
    if (batch.status !== 'proposed') fail('This batch is already committed.');

    

    const from = await applyOverride(tx, actor, batch!, studentId, outcome as PromotionOutcome, trimmed);

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'promotion.overridden', entityType: 'promotion_decision',
      before: { batchId, studentId, finalOutcome: from },
      after: { batchId, studentId, finalOutcome: outcome, reason: trimmed },
      reason: trimmed,
    });
    return { ok: true };
  });
}

/** Bulk review: many students, one human decision, one audit row. */
export async function bulkOverridePromotion(actor: Actor, batchId: number, studentIds: number[], outcome: string, reason: string) {
  if (!canRunPromotion(actor)) fail('Only the principal or vice principal may change promotion decisions.');
  if (!OVERRIDEABLE.includes(outcome as PromotionOutcome)) fail('Choose a valid promotion outcome.');
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 255) fail('Provide a written override reason of at least 10 characters.');
  if (!studentIds.length) fail('Select at least one student.');

  return forSchool(actor.schoolId, async tx => {
    const batch = await loadBatch(tx, actor.schoolId, batchId);
    if (batch.status !== 'proposed') fail('This batch is already committed.');

    const before: Array<{ studentId: number; finalOutcome: PromotionOutcome }> = [];
    for (const studentId of studentIds) {
      before.push({ studentId, finalOutcome: await applyOverride(tx, actor, batch!, studentId, outcome as PromotionOutcome, trimmed) });
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'promotion.bulk_overridden', entityType: 'promotion_decision',
      before: { batchId, decisions: before },
      after: { batchId, count: before.length, finalOutcome: outcome, reason: trimmed },
      reason: trimmed,
    });
    return { ok: true, count: before.length };
  });
}

/**
 * Commit: write NEXT session's enrollments and graduate the graduates, in one
 * transaction. The from-session enrollment and every result row stay exactly
 * as they were — promotion never overwrites history.
 *
 * Refused while any student is unresolved or any promote/trial student has no
 * destination class: committing around either silently loses a child from the
 * roll, and nobody notices until they cannot log in.
 */
export async function commitPromotion(actor: Actor, batchId: number) {
  if (!canCommitPromotion(actor)) fail('Only the principal may commit a promotion.');

  return forSchool(actor.schoolId, async tx => {
    const batch = await loadBatch(tx, actor.schoolId, batchId);
    if (batch.status !== 'proposed') fail('This batch is not open for commit.');

    const decisions = await tx.select().from(schema.promotionDecisions)
      .where(eq(schema.promotionDecisions.batchId, batch.id));

    const unresolved = decisions.filter(d => d.finalOutcome === 'unresolved').length;
    if (unresolved > 0) fail(`${unresolved} student(s) have no published results. Resolve every case before committing.`);

    const missingTarget = decisions.filter(d => (d.finalOutcome === 'promote' || d.finalOutcome === 'trial') && !d.toClassId).length;
    if (missingTarget > 0) fail(`${missingTarget} promoted student(s) have no destination class. Create the class or override the decision.`);

    let enrolled = 0;
    let graduated = 0;

    for (const decision of decisions) {
      if (decision.finalOutcome === 'graduate') {
        await tx.update(schema.students)
          .set({ status: 'graduated', statusChangedAt: new Date() })
          .where(and(eq(schema.students.id, decision.studentId), eq(schema.students.schoolId, actor.schoolId)));
        graduated++;
        continue;
      }

      // UNIQUE (student_id, session_id) makes a re-commit harmless rather than
      // creating a second enrollment for the same year.
      await tx.insert(schema.enrollments).values({
        schoolId: actor.schoolId,
        studentId: decision.studentId,
        classId: decision.toClassId!,
        sessionId: batch.toSessionId,
        status: 'active',
      }).onConflictDoUpdate({
        target: [schema.enrollments.studentId, schema.enrollments.sessionId],
        set: { classId: decision.toClassId!, status: 'active' },
      });
      enrolled++;
    }

    await tx.update(schema.promotionBatches).set({
      status: 'committed', committedBy: actor.userId, committedAt: new Date(),
    }).where(eq(schema.promotionBatches.id, batch.id));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'promotion.committed', entityType: 'promotion_batch',
      before: { batchId, status: 'proposed' },
      after: { batchId, status: 'committed', enrolled, graduated, toSessionId: batch.toSessionId },
    });

    return { ok: true, enrolled, graduated };
  });
}

/**
 * Reverse a committed batch. Promotion touches every student in a year group,
 * so a mistake caught an hour later must be undoable without editing rows by
 * hand. History is preserved: only the to-session enrollments this batch wrote
 * are removed, and graduates are returned to active.
 */
export async function reversePromotion(actor: Actor, batchId: number, reason: string) {
  if (!canCommitPromotion(actor)) fail('Only the principal may reverse a promotion.');
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 255) fail('Provide a written reason of at least 10 characters for reversing a promotion.');

  return forSchool(actor.schoolId, async tx => {
    const batch = await loadBatch(tx, actor.schoolId, batchId);
    if (batch.status !== 'committed') fail('Only a committed batch can be reversed.');

    const decisions = await tx.select().from(schema.promotionDecisions)
      .where(eq(schema.promotionDecisions.batchId, batch.id));
    const ids = decisions.map(d => d.studentId);
    const graduates = decisions.filter(d => d.finalOutcome === 'graduate').map(d => d.studentId);

    const removed = await tx.delete(schema.enrollments).where(and(
      eq(schema.enrollments.schoolId, actor.schoolId),
      eq(schema.enrollments.sessionId, batch.toSessionId),
      inArray(schema.enrollments.studentId, ids),
    )).returning({ id: schema.enrollments.id });

    if (graduates.length) {
      await tx.update(schema.students).set({ status: 'active', statusChangedAt: new Date() })
        .where(and(
          eq(schema.students.schoolId, actor.schoolId),
          inArray(schema.students.id, graduates),
          eq(schema.students.status, 'graduated'),
        ));
    }

    await tx.update(schema.promotionBatches).set({
      status: 'reversed', reversedBy: actor.userId, reversedAt: new Date(),
    }).where(eq(schema.promotionBatches.id, batch.id));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'promotion.reversed', entityType: 'promotion_batch',
      before: { batchId, status: 'committed' },
      after: { batchId, status: 'reversed', removedEnrollments: removed.length, reinstated: graduates.length },
      reason: trimmed,
    });

    return { ok: true, removed: removed.length, reinstated: graduates.length };
  });
}

/** The office list: every batch with its scope names. */
export async function promotionBatches(actor: Actor) {
  if (!canRunPromotion(actor)) fail('Only the principal or vice principal may view promotion.');
  return forSchool(actor.schoolId, async tx => {
    const rows = await tx.select({
      batch: schema.promotionBatches,
      levelName: schema.classLevels.name,
      fromTitle: sql<string>`(SELECT title FROM ${schema.academicSessions} WHERE id = ${schema.promotionBatches.fromSessionId})`,
      toTitle: sql<string>`(SELECT title FROM ${schema.academicSessions} WHERE id = ${schema.promotionBatches.toSessionId})`,
    }).from(schema.promotionBatches)
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.promotionBatches.levelId))
      .where(eq(schema.promotionBatches.schoolId, actor.schoolId))
      .orderBy(desc(schema.promotionBatches.id));
    return rows;
  });
}

/** The review screen: the batch, every decision with student identity, the
 *  borderline cases, and the class names for from/to. The principal should see
 *  five numbers and the handful of students who need a human — not scroll 500
 *  rows — but every row is here for bulk review. */
export async function promotionReview(actor: Actor, batchId: number) {
  if (!canRunPromotion(actor)) fail('Only the principal or vice principal may view promotion.');
  return forSchool(actor.schoolId, async tx => {
    const batch = await loadBatch(tx, actor.schoolId, batchId);

    const decisions = await tx.select({
      decision: schema.promotionDecisions,
      firstName: schema.students.firstName,
      lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber,
      status: schema.students.status,
    }).from(schema.promotionDecisions)
      .innerJoin(schema.students, eq(schema.students.id, schema.promotionDecisions.studentId))
      .where(eq(schema.promotionDecisions.batchId, batch.id))
      .orderBy(asc(schema.promotionDecisions.studentId));

    const rules = batch.rules as unknown as PromotionRules | null ?? defaultRules();
    const borderline = decisions
      .filter(d => d.decision.finalOutcome === 'promote' && Number(d.decision.averageScore) < rules.promoteAverage + 3)
      .map(d => d.decision.studentId);

    const fromClassNames = new Map<number, string>();
    const toClassNames = new Map<number, string>();
    const classIds = [...new Set(decisions.flatMap(d => [d.decision.fromClassId, d.decision.toClassId].filter((c): c is number => c !== null)))];
    if (classIds.length) {
      for (const row of await tx.select({ id: schema.classes.id, name: schema.classes.displayName })
        .from(schema.classes).where(inArray(schema.classes.id, classIds))) {
        fromClassNames.set(row.id, row.name);
        toClassNames.set(row.id, row.name);
      }
    }

    return {
      batch,
      rules,
      summary: {
        evaluated: batch.totalEvaluated,
        promoted: batch.totalPromoted,
        trial: batch.totalTrial,
        repeated: batch.totalRepeated,
        graduated: batch.totalGraduated,
        unresolved: batch.totalUnresolved,
      },
      decisions: decisions.map(d => ({
        studentId: d.decision.studentId,
        name: `${d.firstName} ${d.lastName}`,
        admissionNumber: d.admissionNumber,
        studentStatus: d.status,
        fromClass: fromClassNames.get(d.decision.fromClassId ?? 0) ?? null,
        toClass: toClassNames.get(d.decision.toClassId ?? 0) ?? null,
        proposedOutcome: d.decision.proposedOutcome,
        finalOutcome: d.decision.finalOutcome,
        averageScore: Number(d.decision.averageScore),
        subjectsPassed: d.decision.subjectsPassed,
        subjectsOffered: d.decision.subjectsOffered,
        note: d.decision.note,
        overrideReason: d.decision.overrideReason,
        overridden: d.decision.overrideReason !== '',
      })),
      borderline,
    };
  });
}
