/**
 * Test/Exam Sessions (legacy templates/portal/exams/sessions.php) — search a
 * student's sitting history across every paper they have attempted, and grant
 * a reattempt when a sitting ended unfairly (a machine crash, a lockout, a
 * genuine dispute over an integrity flag).
 *
 * Distinct from invigilate.ts, which watches sessions live, right now. This
 * page looks backward, across any subject, any class, any term.
 */

import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { isWide } from './invigilate';

export type SessionFilters = {
  q?: string;
  subjectId?: number;
  status?: string;
  seriesType?: string;
  classId?: number;
  sessionId?: number;
  termId?: number;
};

export type SessionRow = {
  attemptId: number;
  paperId: number;
  studentId: number;
  studentName: string;
  admissionNumber: string;
  subjectName: string;
  className: string | null;
  seriesTitle: string;
  seriesType: string;
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  submitReason: string | null;
  score: string | null;
  maxScore: string | null;
  integrityCount: number;
  canReattempt: boolean;
};

export type SessionFilterOptions = {
  subjects: { id: number; name: string }[];
  classes: { id: number; name: string }[];
  sessions: { id: number; title: string }[];
  terms: { id: number; title: string; sessionId: number }[];
};

const ELIGIBLE_FOR_REATTEMPT: string[] = ['submitted', 'auto_submitted', 'expired', 'cancelled'];

export async function sessionFilterOptions(actor: Actor): Promise<SessionFilterOptions> {
  return forSchool(actor.schoolId, async (tx) => {
    const [subjects, classes, sessionsList, terms] = await Promise.all([
      tx.select({ id: schema.subjects.id, name: schema.subjects.name })
        .from(schema.subjects).where(eq(schema.subjects.schoolId, actor.schoolId)).orderBy(asc(schema.subjects.name)),
      tx.select({ id: schema.classes.id, name: schema.classes.displayName })
        .from(schema.classes).where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
        .orderBy(asc(schema.classes.displayName)),
      tx.select({ id: schema.academicSessions.id, title: schema.academicSessions.title })
        .from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, actor.schoolId))
        .orderBy(desc(schema.academicSessions.id)),
      tx.select({ id: schema.terms.id, title: schema.terms.title, sessionId: schema.terms.sessionId })
        .from(schema.terms).where(eq(schema.terms.schoolId, actor.schoolId))
        .orderBy(desc(schema.terms.id)),
    ]);
    return { subjects, classes, sessions: sessionsList, terms };
  });
}

/**
 * With no filter at all, this is the live board the page's header promises:
 * whoever is writing right now, school-wide (or, for a subject teacher,
 * their own subjects) — a small, bounded, real-time list, not a dump. A
 * student's whole attempt HISTORY is a different matter: that only comes
 * back once the caller gives us something to search on (a name, admission
 * number, subject, class, session or term) — nobody should be able to pull
 * a full history dump just by opening the page with no query at all.
 */
export async function searchSessions(actor: Actor, filters: SessionFilters): Promise<SessionRow[]> {
  const hasFilter = Boolean(filters.q?.trim() || filters.subjectId || filters.status
    || filters.seriesType || filters.classId || filters.sessionId || filters.termId);
  if (!hasFilter) filters = { ...filters, status: 'in_progress' };

  const wide = isWide(actor);

  return forSchool(actor.schoolId, async (tx) => {
    let teacherSubjectIds: number[] | null = null;
    if (!wide) {
      if (!actor.staffId) return [];
      const mine = await tx.select({ subjectId: schema.staffAssignments.subjectId })
        .from(schema.staffAssignments)
        .where(and(eq(schema.staffAssignments.staffId, actor.staffId), eq(schema.staffAssignments.status, 'active')));
      teacherSubjectIds = mine.map((m) => m.subjectId).filter((id): id is number => id !== null);
      if (teacherSubjectIds.length === 0) return [];
    }

    const q = filters.q?.trim();
    const rows = await tx
      .select({
        attemptId: schema.attempts.id,
        paperId: schema.attempts.paperId,
        studentId: schema.students.id,
        studentName: sql<string>`${schema.students.firstName} || ' ' || ${schema.students.lastName}`,
        admissionNumber: schema.students.admissionNumber,
        subjectId: schema.subjects.id,
        subjectName: schema.subjects.name,
        className: schema.classes.displayName,
        seriesTitle: schema.examSeries.title,
        seriesType: schema.examSeries.seriesType,
        status: schema.attempts.status,
        startedAt: schema.attempts.startedAt,
        submittedAt: schema.attempts.submittedAt,
        submitReason: schema.attempts.submitReason,
        score: schema.attempts.score,
        maxScore: schema.attempts.maxScore,
        integrityCount: schema.attempts.integrityCount,
      })
      .from(schema.attempts)
      .innerJoin(schema.students, eq(schema.students.id, schema.attempts.studentId))
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .where(and(
        eq(schema.attempts.schoolId, actor.schoolId),
        teacherSubjectIds ? inArray(schema.subjects.id, teacherSubjectIds) : sql`true`,
        q ? or(
          ilike(schema.students.firstName, `%${q}%`),
          ilike(schema.students.lastName, `%${q}%`),
          ilike(schema.students.admissionNumber, `%${q}%`),
          ilike(sql`${schema.students.firstName} || ' ' || ${schema.students.lastName}`, `%${q}%`),
        ) : sql`true`,
        filters.subjectId ? eq(schema.subjects.id, filters.subjectId) : sql`true`,
        filters.status ? eq(schema.attempts.status, filters.status as 'in_progress') : sql`true`,
        filters.seriesType ? eq(schema.examSeries.seriesType, filters.seriesType as 'examination') : sql`true`,
        filters.classId ? eq(schema.examPapers.classId, filters.classId) : sql`true`,
        filters.sessionId ? eq(schema.examSeries.sessionId, filters.sessionId) : sql`true`,
        filters.termId ? eq(schema.examSeries.termId, filters.termId) : sql`true`,
      ))
      .orderBy(desc(schema.attempts.startedAt))
      .limit(100);

    return rows.map((r) => ({
      ...r,
      canReattempt: wide && ELIGIBLE_FOR_REATTEMPT.includes(r.status),
    }));
  });
}

/**
 * Reset an attempt to `in_progress` so the student can sit the same paper
 * again — the plugin's "session ended unfairly" remedy. Attempts are 1:1
 * with (paper, student) at the schema level, so a reattempt is a reset, not
 * a second row: previous answers are cleared, a fresh window is opened, and
 * the reset itself is written to the audit log so the original sitting's
 * story is never silently lost.
 */
export async function grantReattempt(
  actor: Actor,
  attemptId: number,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isWide(actor)) return { ok: false, error: 'not_allowed' };
  if (reason.trim() === '') return { ok: false, error: 'reason_required' };

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx
      .select({
        status: schema.attempts.status,
        durationSeconds: schema.examPapers.durationSeconds,
        paperStatus: schema.examPapers.status,
      })
      .from(schema.attempts)
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .where(and(eq(schema.attempts.id, attemptId), eq(schema.attempts.schoolId, actor.schoolId)))
      .limit(1);

    if (!row) return { ok: false, error: 'attempt_not_found' };
    if (!ELIGIBLE_FOR_REATTEMPT.includes(row.status)) return { ok: false, error: 'not_eligible' };
    if (row.paperStatus === 'cancelled') return { ok: false, error: 'paper_cancelled' };

    const before = { status: row.status };

    await tx.delete(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, attemptId));

    await tx.update(schema.attempts).set({
      status: 'in_progress',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + row.durationSeconds * 1000),
      submittedAt: null,
      submitReason: null,
      extensionSeconds: 0,
      score: null,
      maxScore: null,
      bookmarkCount: 0,
      integrityCount: 0,
      lastSyncedAt: null,
    }).where(eq(schema.attempts.id, attemptId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.attempt_reattempt_granted',
      entityType: 'attempts',
      entityId: attemptId,
      before,
      reason: reason.slice(0, 500),
    });

    return { ok: true };
  });
}
