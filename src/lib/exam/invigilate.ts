/**
 * The invigilator's live board (legacy templates/portal/exams/invigilate.php,
 * includes/Services/InvigilatorService.php).
 *
 * Answers the four questions an invigilator actually has: who has not
 * started, who looks disconnected, who is flagged, and how long each
 * student has left.
 *
 * WHO CAN WATCH: school-wide roles see every session; a subject teacher sees
 * the sessions for their assigned subjects; a paper's assigned invigilator
 * always sees that paper.
 */

import { and, asc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { forSchool, schema, Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { SCHOOL_WIDE } from '@/lib/session';
import { submitAttempt } from './engine';

const QUIET_AFTER_MS = 2 * 60 * 1000; // "no activity for 2 min"

export type LivePaper = {
  id: number;
  subjectName: string;
  className: string | null;
  levelName: string | null;
  scheduledAt: Date;
  closesAt: Date;
  requiresAccessCode: boolean;
  accessCode: string | null;
  released: boolean;
};

export type BoardRow = {
  studentId: number;
  name: string;
  admissionNumber: string;
  attemptId: number | null;
  state: string;
  answered: number;
  total: number;
  remainingSeconds: number | null;
  extensionMinutes: number;
  flags: number;
  quiet: boolean;
  submitReason: string | null;
};

export type Board = {
  paper: LivePaper;
  released: boolean;
  summary: { notStarted: number; inProgress: number; submitted: number; quiet: number; flagged: number };
  students: BoardRow[];
  canIntervene: boolean;
};

export function isWide(actor: Actor): boolean {
  return SCHOOL_WIDE.includes(actor.role as (typeof SCHOOL_WIDE)[number]);
}

async function subjectIdsOf(tx: Tx, schoolId: number, staffId: number): Promise<number[]> {
  const rows = await tx.selectDistinct({ subjectId: schema.staffAssignments.subjectId })
    .from(schema.staffAssignments)
    .where(and(
      eq(schema.staffAssignments.schoolId, schoolId),
      eq(schema.staffAssignments.staffId, staffId),
      eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
      eq(schema.staffAssignments.status, 'active'),
      isNotNull(schema.staffAssignments.subjectId),
    ));
  return rows.map((r) => r.subjectId!);
}

/**
 * Papers that are live right now (legacy window: still open or starting
 * within the next day). Scoped: wide roles see all; a teacher sees papers in
 * their subjects plus papers they invigilate.
 */
export async function livePapers(actor: Actor): Promise<LivePaper[]> {
  if (actor.role === 'parent' || actor.role === 'student') return [];

  return forSchool(actor.schoolId, async (tx) => {
    const now = Date.now();
    const horizon = new Date(now + 24 * 60 * 60 * 1000);

    const conditions = [
      eq(schema.examPapers.schoolId, actor.schoolId),
      eq(schema.examPapers.status, 'published'),
      isNotNull(schema.examPapers.scheduledAt),
      lt(schema.examPapers.scheduledAt, horizon),
    ];

    if (!isWide(actor) && actor.staffId !== null) {
      const subjects = await subjectIdsOf(tx, actor.schoolId, actor.staffId);
      const scope = [eq(schema.examPapers.invigilatorStaffId, actor.staffId)];
      if (subjects.length) scope.push(inArray(schema.examPapers.subjectId, subjects));
      conditions.push(or(...scope)!);
    }

    const rows = await tx.select({
      id: schema.examPapers.id,
      subjectName: schema.subjects.name,
      className: schema.classes.displayName,
      levelName: schema.classLevels.name,
      scheduledAt: schema.examPapers.scheduledAt,
      closesAt: schema.examPapers.closesAt,
      durationSeconds: schema.examPapers.durationSeconds,
      requiresAccessCode: schema.examPapers.requiresAccessCode,
      accessCode: schema.examPapers.accessCode,
      codeReleasedAt: schema.examPapers.codeReleasedAt,
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
      .where(and(...conditions))
      .orderBy(asc(schema.examPapers.scheduledAt));

    // Keep only papers whose window still overlaps "yesterday → tomorrow".
    return rows
      .filter((r) => {
        const start = r.scheduledAt!.getTime();
        const end = (r.closesAt ?? new Date(start + r.durationSeconds * 1000)).getTime();
        return end > now - 24 * 60 * 60 * 1000;
      })
      .map((r) => ({
        id: r.id,
        subjectName: r.subjectName,
        className: r.className,
        levelName: r.levelName,
        scheduledAt: r.scheduledAt!,
        closesAt: r.closesAt ?? new Date(r.scheduledAt!.getTime() + r.durationSeconds * 1000),
        requiresAccessCode: r.requiresAccessCode,
        accessCode: r.accessCode,
        released: r.codeReleasedAt !== null,
      }));
  });
}

/**
 * The board for one paper. Candidates are every student registered for the
 * paper's subject; their attempt state is left-joined so the invigilator
 * sees who has NOT started, not only who has.
 */
export async function boardFor(actor: Actor, paperId: number): Promise<Board | null> {
  if (!Number.isInteger(paperId) || paperId <= 0) return null;
  if (actor.role === 'parent' || actor.role === 'student') return null;

  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select({
      id: schema.examPapers.id,
      subjectId: schema.examPapers.subjectId,
      subjectName: schema.subjects.name,
      className: schema.classes.displayName,
      levelName: schema.classLevels.name,
      scheduledAt: schema.examPapers.scheduledAt,
      closesAt: schema.examPapers.closesAt,
      durationSeconds: schema.examPapers.durationSeconds,
      requiresAccessCode: schema.examPapers.requiresAccessCode,
      accessCode: schema.examPapers.accessCode,
      codeReleasedAt: schema.examPapers.codeReleasedAt,
      invigilatorStaffId: schema.examPapers.invigilatorStaffId,
      status: schema.examPapers.status,
      questionCount: schema.examPapers.questionCount,
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!paper || paper.status !== 'published' || !paper.scheduledAt) return null;

    // Who may watch this paper: wide roles, the assigned invigilator, or a
    // subject teacher of this paper's subject (the legacy scoping).
    let mayWatch = isWide(actor);
    if (!mayWatch && actor.staffId !== null) {
      if (paper.invigilatorStaffId === actor.staffId) {
        mayWatch = true;
      } else {
        const subjects = await subjectIdsOf(tx, actor.schoolId, actor.staffId);
        mayWatch = subjects.includes(paper.subjectId);
      }
    }
    if (!mayWatch) return null;

    const candidates = await tx.select({
      studentId: schema.students.id,
      firstName: schema.students.firstName,
      lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber,
    })
      .from(schema.studentSubjects)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentSubjects.studentId))
      .where(and(
        eq(schema.studentSubjects.schoolId, actor.schoolId),
        eq(schema.studentSubjects.subjectId, paper.subjectId),
        eq(schema.students.status, 'active'),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    const studentIds = candidates.map((c) => c.studentId);

    const attemptRows = studentIds.length
      ? await tx.select().from(schema.attempts)
          .where(and(
            eq(schema.attempts.schoolId, actor.schoolId),
            eq(schema.attempts.paperId, paperId),
            inArray(schema.attempts.studentId, studentIds),
          ))
      : [];

    const attemptByStudent = new Map(attemptRows.map((a) => [Number(a.studentId), a]));

    const answeredRows = attemptRows.length
      ? await tx.select({
          attemptId: schema.attemptAnswers.attemptId,
          n: sql<number>`count(*) filter (where ${schema.attemptAnswers.optionId} is not null or ${schema.attemptAnswers.textAnswer} is not null)`,
        })
          .from(schema.attemptAnswers)
          .where(inArray(schema.attemptAnswers.attemptId, attemptRows.map((a) => Number(a.id))))
          .groupBy(schema.attemptAnswers.attemptId)
      : [];
    const answeredByAttempt = new Map(answeredRows.map((r) => [Number(r.attemptId), Number(r.n)]));

    const now = Date.now();
    const students: BoardRow[] = candidates.map((c) => {
      const attempt = attemptByStudent.get(c.studentId);
      const state = attempt ? attempt.status : 'not_started';
      const remainingSeconds = attempt && attempt.status === 'in_progress'
        ? Math.max(0, Math.floor((attempt.expiresAt.getTime() - now) / 1000))
        : null;
      const quiet = !!(attempt
        && attempt.status === 'in_progress'
        && attempt.lastSyncedAt
        && now - attempt.lastSyncedAt.getTime() > QUIET_AFTER_MS);

      return {
        studentId: c.studentId,
        name: `${c.firstName} ${c.lastName ?? ''}`.trim(),
        admissionNumber: c.admissionNumber,
        attemptId: attempt ? Number(attempt.id) : null,
        state,
        answered: attempt ? (answeredByAttempt.get(Number(attempt.id)) ?? 0) : 0,
        total: attempt ? attempt.questionOrder.length : paper.questionCount,
        remainingSeconds,
        extensionMinutes: attempt ? Math.round(attempt.extensionSeconds / 60) : 0,
        flags: attempt ? attempt.integrityCount : 0,
        quiet,
        submitReason: attempt?.submitReason ?? null,
      };
    });

    const summary = {
      notStarted: students.filter((s) => s.state === 'not_started').length,
      inProgress: students.filter((s) => s.state === 'in_progress').length,
      submitted: students.filter((s) => s.state === 'submitted' || s.state === 'auto_submitted').length,
      quiet: students.filter((s) => s.quiet).length,
      flagged: students.filter((s) => s.flags > 0).length,
    };

    return {
      paper: {
        id: paper.id,
        subjectName: paper.subjectName,
        className: paper.className,
        levelName: paper.levelName,
        scheduledAt: paper.scheduledAt,
        closesAt: paper.closesAt ?? new Date(paper.scheduledAt.getTime() + paper.durationSeconds * 1000),
        requiresAccessCode: paper.requiresAccessCode,
        accessCode: paper.accessCode,
        released: paper.codeReleasedAt !== null,
      },
      released: paper.codeReleasedAt !== null,
      summary,
      students,
      // Only the office (and the assigned invigilator) may intervene.
      canIntervene: isWide(actor) || (actor.staffId !== null && paper.invigilatorStaffId === actor.staffId),
    };
  });
}

// ── Interventions ────────────────────────────────────────────────────────────

export type ExtensionResult =
  | { ok: true; extensionSeconds?: number; attemptsExtended?: number }
  | { ok: false; error: string };

function validateExtension(minutes: number, reason: string): string | null {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 120) return 'implausible_extension';
  if (reason.trim() === '') return 'reason_required';
  return null;
}

/**
 * Grant one student extra time. ADDITIVE and applied to the whole attempt, so
 * it works whether granted before the student starts or in the last minute.
 * The server clock moves expiresAt itself — the browser timer just renders it.
 */
export async function grantExtension(
  actor: Actor,
  attemptId: number,
  minutes: number,
  reason: string,
): Promise<ExtensionResult> {
  if (!isWide(actor) && actor.role !== 'teacher') return { ok: false, error: 'not_allowed' };
  const invalid = validateExtension(minutes, reason);
  if (invalid) return { ok: false, error: invalid };

  return forSchool(actor.schoolId, async (tx) => {
    const [attempt] = await tx.select().from(schema.attempts)
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!attempt) return { ok: false, error: 'attempt_not_found' } as const;
    if (attempt.status !== 'in_progress') return { ok: false, error: 'attempt_closed' } as const;

    const seconds = minutes * 60;
    await tx.update(schema.attempts)
      .set({
        extensionSeconds: attempt.extensionSeconds + seconds,
        expiresAt: new Date(attempt.expiresAt.getTime() + seconds * 1000),
      })
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, actor.schoolId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.extension_granted',
      entityType: 'attempts',
      entityId: attemptId,
      reason: reason.slice(0, 500),
      after: { minutes, paperId: Number(attempt.paperId), studentId: Number(attempt.studentId) },
    });

    return { ok: true, extensionSeconds: attempt.extensionSeconds + seconds } as const;
  });
}

/**
 * Extend every in-progress attempt on a paper at once. This is the one that
 * matters in practice: the power went out for six minutes and the whole hall
 * needs those six minutes back.
 */
export async function extendPaper(
  actor: Actor,
  paperId: number,
  minutes: number,
  reason: string,
): Promise<ExtensionResult> {
  if (!isWide(actor) && actor.role !== 'teacher') return { ok: false, error: 'not_allowed' };
  const invalid = validateExtension(minutes, reason);
  if (invalid) return { ok: false, error: invalid };

  return forSchool(actor.schoolId, async (tx) => {
    const affected = await tx.update(schema.attempts)
      .set({
        extensionSeconds: sql`${schema.attempts.extensionSeconds} + ${minutes * 60}`,
        expiresAt: sql`${schema.attempts.expiresAt} + (${minutes * 60} * interval '1 second')`,
      })
      .where(and(
        eq(schema.attempts.schoolId, actor.schoolId),
        eq(schema.attempts.paperId, paperId),
        eq(schema.attempts.status, 'in_progress'),
      ))
      .returning({ id: schema.attempts.id });

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.paper_extended',
      entityType: 'exam_papers',
      entityId: paperId,
      reason: reason.slice(0, 500),
      after: { minutes, attempts: affected.length },
    });

    return { ok: true, attemptsExtended: affected.length } as const;
  });
}

/**
 * Force a submission — a student who walked out, or a machine that has to be
 * freed for the next session. Their saved answers are marked as they stand.
 */
export async function forceSubmit(
  actor: Actor,
  attemptId: number,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (reason.trim() === '') return { ok: false, error: 'reason_required' };

  const attempt = await forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select({
      studentId: schema.attempts.studentId,
      status: schema.attempts.status,
    })
      .from(schema.attempts)
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, actor.schoolId),
      ))
      .limit(1);
    return row;
  });

  if (!attempt) return { ok: false, error: 'attempt_not_found' };
  if (attempt.status !== 'in_progress') return { ok: true };
  if (!isWide(actor) && actor.role !== 'teacher') return { ok: false, error: 'not_allowed' };

  // submitAttempt marks the saved answers as they stand; forcedReason records
  // why the attempt closed. Two transactions, because forSchool cannot nest.
  const result = await submitAttempt(actor.schoolId, attemptId, Number(attempt.studentId), false, reason.trim());
  if (!result.ok) return { ok: false, error: result.reason ?? 'submit_failed' };

  await forSchool(actor.schoolId, async (tx) => {
    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.attempt_force_submitted',
      entityType: 'attempts',
      entityId: attemptId,
      reason: reason.slice(0, 500),
    });
  });

  return { ok: true };
}
