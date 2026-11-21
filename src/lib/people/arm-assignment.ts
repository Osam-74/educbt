/**
 * Splitting a class into arms: moving students from a class that has no arms (SS1) into an arm of the SAME level
 * (SS1 A, SS1 B). Not a promotion: nobody is promoted, repeated or demoted, the student's enrolment is kept and simply
 * points at the new class, so attempts, history and registrations stay attached.
 *
 * This file is the rules only (no database), so each one is easy to prove. The service that applies them is below it.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import { isSchoolWide } from '@/lib/queries';
import type { Actor } from '@/lib/session';
import { currentSessionId } from './students';

export type ArmFrom = { classId: number; levelId: number };
export type ArmTo = { classId: number; levelId: number; active: boolean; /** Seats (0 = no limit) and how many are already taken. */ capacity?: number; occupied?: number };

export type ArmFacts = {
  /** The student has an active enrolment in the CURRENT session. */
  enrolledThisSession: boolean;
  /** Assessment scores already recorded for this student this term. */
  scoresThisTerm: number;
  /** Results already compiled for this student this term. A class's results move through the pipeline together. */
  resultsThisTerm: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** '' when the move is allowed, otherwise a short reason the office can act on. */
export function armRefusal(from: ArmFrom, to: ArmTo, facts: ArmFacts): string {
  if (!facts.enrolledThisSession) return 'Not enrolled in the current session.';
  if (to.classId === from.classId) return 'Already in that class.';
  if (!to.active) return 'That class is not active.';
  if (to.levelId <= 0 || to.levelId !== from.levelId) return 'A different level. Use Promotion to move students between levels.';
  if ((to.capacity ?? 0) > 0 && (to.occupied ?? 0) >= (to.capacity ?? 0)) return 'That class has reached its capacity.';
  if (facts.resultsThisTerm > 0) {
    return `Already has results compiled this term (${plural(facts.resultsThisTerm, 'subject', 'subjects')}). A class's results are signed off together, so split the class before results are compiled.`;
  }
  if (facts.scoresThisTerm > 0) {
    return `Already has ${plural(facts.scoresThisTerm, 'score', 'scores')} recorded this term. Split the class first, then record scores.`;
  }
  return '';
}

export const ARM_BATCH_LIMIT = 500;

/**
 * Which classes may this person move students in and out of? null means every class (school-wide roles).
 * A class teacher manages only the classes they are class teacher for; a subject teacher manages none.
 * Decided here, on the server, every time. The page hiding a button is only presentation.
 */
export async function manageableClassIds(tx: Parameters<Parameters<typeof forSchool>[1]>[0], actor: Actor): Promise<number[] | null> {
  if (isSchoolWide(actor.role)) return null;
  if (actor.role !== 'teacher' || !actor.staffId) return [];
  const rows = await tx.select({ classId: schema.staffAssignments.classId }).from(schema.staffAssignments).where(and(
    eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId),
    eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
  return [...new Set(rows.map((r) => Number(r.classId)))];
}

/** The classes a student of this class could be split into: the same level, active, not the class itself. */
export async function armTargets(actor: Actor, classId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const allowed = await manageableClassIds(tx, actor);
    if (allowed !== null && !allowed.includes(classId)) return [];
    const [from] = await tx.select({ levelId: schema.classes.levelId }).from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    if (!from) return [];
    const rows = await tx.select({ id: schema.classes.id, name: schema.classes.displayName, arm: schema.classes.arm }).from(schema.classes).where(and(
      eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.levelId, from.levelId), eq(schema.classes.status, 'active'), sql`${schema.classes.id} <> ${classId}`));
    return rows.filter((r) => allowed === null || allowed.includes(Number(r.id))).map((r) => ({ id: Number(r.id), name: r.name, arm: r.arm ?? '' }))
      .sort((a, b) => a.arm.localeCompare(b.arm) || a.name.localeCompare(b.name));
  });
}

export type ArmResult =
  | { success: true; moved: number; skipped: Array<{ studentId: number; name: string; reason: string }> }
  | { success: false; error: string; moved: 0; skipped: [] };

/**
 * Move the ticked students into one arm. All in one transaction: a database error rolls the whole batch back, while a
 * student who is merely refused by a rule is skipped and reported (that is not an error). Nothing is deleted.
 */
export async function assignToArm(actor: Actor, studentIds: number[], toClassId: number): Promise<ArmResult> {
  const fail = (error: string): ArmResult => ({ success: false, error, moved: 0, skipped: [] });
  const ids = [...new Set(studentIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return fail('Tick at least one student.');
  if (ids.length > ARM_BATCH_LIMIT) return fail(`Move at most ${ARM_BATCH_LIMIT} students at a time.`);

  return forSchool(actor.schoolId, async (tx): Promise<ArmResult> => {
    const allowed = await manageableClassIds(tx, actor);
    if (allowed !== null && allowed.length === 0) return fail('Only a principal, the exam office or a class teacher can move students between arms.');
    const [target] = await tx.select().from(schema.classes)
      .where(and(eq(schema.classes.id, toClassId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    if (!target) return fail('Choose the arm to move them into.');
    if (allowed !== null && !allowed.includes(toClassId)) return fail('You cannot move students into that class.');

    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return fail('There is no current session.');
    const [term] = await tx.select({ id: schema.terms.id }).from(schema.terms)
      .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.sessionId, sessionId), eq(schema.terms.isCurrent, true))).limit(1);
    const termId = term ? Number(term.id) : 0;

    const enrolled = await tx.select({
      enrollmentId: schema.enrollments.id, studentId: schema.enrollments.studentId, classId: schema.enrollments.classId,
      levelId: schema.classes.levelId, first: schema.students.firstName, last: schema.students.lastName,
    }).from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .innerJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
      .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.sessionId, sessionId),
        eq(schema.enrollments.status, 'active'), inArray(schema.enrollments.studentId, ids)));
    const byStudent = new Map(enrolled.map((r) => [Number(r.studentId), r]));
    const scoreCounts = termId ? await tx.select({ studentId: schema.assessmentScores.studentId, n: sql<number>`count(*)`.mapWith(Number) }).from(schema.assessmentScores)
      .where(and(eq(schema.assessmentScores.schoolId, actor.schoolId), eq(schema.assessmentScores.sessionId, sessionId), eq(schema.assessmentScores.termId, termId), inArray(schema.assessmentScores.studentId, ids)))
      .groupBy(schema.assessmentScores.studentId) : [];
    const resultCounts = termId ? await tx.select({ studentId: schema.subjectResults.studentId, n: sql<number>`count(*)`.mapWith(Number) }).from(schema.subjectResults)
      .where(and(eq(schema.subjectResults.schoolId, actor.schoolId), eq(schema.subjectResults.sessionId, sessionId), eq(schema.subjectResults.termId, termId), inArray(schema.subjectResults.studentId, ids)))
      .groupBy(schema.subjectResults.studentId) : [];
    const scores = new Map(scoreCounts.map((r) => [Number(r.studentId), r.n])), results = new Map(resultCounts.map((r) => [Number(r.studentId), r.n]));

    const [occ] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.enrollments)
      .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, toClassId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    let occupied = occ?.n ?? 0;
    const skipped: Array<{ studentId: number; name: string; reason: string }> = [];
    let moved = 0;
    for (const studentId of ids) {
      const r = byStudent.get(studentId);
      if (!r) {
        const [known] = await tx.select({ first: schema.students.firstName, last: schema.students.lastName }).from(schema.students)
          .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
        skipped.push({ studentId, name: known ? `${known.first} ${known.last}` : 'Unknown student', reason: known ? 'Not enrolled in the current session.' : 'Student not found.' });
        continue;
      }
      const name = `${r.first} ${r.last}`;
      if (allowed !== null && !allowed.includes(Number(r.classId))) { skipped.push({ studentId, name, reason: 'Not in a class you manage.' }); continue; }
      const why = armRefusal({ classId: Number(r.classId), levelId: Number(r.levelId) }, { classId: toClassId, levelId: Number(target.levelId), active: target.status === 'active', capacity: Number(target.capacity), occupied },
        { enrolledThisSession: true, scoresThisTerm: scores.get(studentId) ?? 0, resultsThisTerm: results.get(studentId) ?? 0 });
      if (why) { skipped.push({ studentId, name, reason: why }); continue; }
      await tx.update(schema.enrollments).set({ classId: toClassId })
        .where(and(eq(schema.enrollments.id, r.enrollmentId), eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.status, 'active')));
      moved++; occupied++;
      await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role, action: 'student.arm_assigned',
        entityType: 'enrollments', entityId: Number(r.enrollmentId), before: { classId: Number(r.classId) }, after: { classId: toClassId } });
    }
    return { success: true, moved, skipped };
  });
}

/**
 * The classes this person can split, and the students in one of them. Both follow the SAME scope as the move itself
 * (manageableClassIds), so the list on the screen and what the server will accept can never disagree.
 */
export async function armSources(actor: Actor) {
  return forSchool(actor.schoolId, async (tx) => {
    const allowed = await manageableClassIds(tx, actor);
    if (allowed !== null && allowed.length === 0) return [];
    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return [];
    const rows = await tx.select({ id: schema.classes.id, name: schema.classes.displayName, levelId: schema.classes.levelId, arm: schema.classes.arm,
      students: sql<number>`(SELECT count(*) FROM ${schema.enrollments} e WHERE e.class_id = classes.id AND e.session_id = ${sessionId} AND e.status = 'active')`.mapWith(Number) })
      .from(schema.classes).where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')));
    // A class is worth offering only when it has somewhere to split into: another active class of the same level.
    const byLevel = new Map<number, number>();
    for (const r of rows) byLevel.set(Number(r.levelId), (byLevel.get(Number(r.levelId)) ?? 0) + 1);
    return rows.filter((r) => (allowed === null || allowed.includes(Number(r.id))) && (byLevel.get(Number(r.levelId)) ?? 0) > 1 && r.students > 0)
      .map((r) => ({ id: Number(r.id), name: r.name, arm: r.arm ?? '', students: r.students })).sort((a, b) => a.name.localeCompare(b.name));
  });
}

export async function armRoster(actor: Actor, classId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const allowed = await manageableClassIds(tx, actor);
    if (allowed === null ? false : !allowed.includes(classId)) return [];
    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return [];
    return tx.select({ id: schema.students.id, admissionNumber: schema.students.admissionNumber, firstName: schema.students.firstName, lastName: schema.students.lastName })
      .from(schema.enrollments).innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, classId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active'),
        inArray(schema.students.status, ['active', 'pending_approval'])))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));
  });
}
