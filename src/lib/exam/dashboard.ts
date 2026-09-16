/**
 * Examination Officer dashboard — stats, pipeline, next papers, recent sittings.
 *
 * Legacy reference: templates/portal/exams/index.php ("Overview" — the
 * Examinations area's menu root). That page is scoped for both a school-wide
 * officer and a subject teacher; this route (`/portal/exams`) is reachable
 * only by SCHOOL_WIDE roles (see PortalShell's nav and requireRole in
 * src/app/portal/exams/page.tsx), so only the wide branch is ported here.
 *
 * The pipeline widget is the point of the page: the stat tiles report volume,
 * this reports what to do NEXT, in the order it must happen.
 */

import { and, eq, ne, sql, inArray, isNull, desc } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { currentSessionId } from '@/lib/people/students';

export type PipelineState = 'done' | 'act' | 'wait' | 'idle';

export type PipelineStage = {
  label: string;
  state: PipelineState;
  note: string;
  href: string;
  action: string;
};

export type UpcomingPaper = {
  id: number;
  subjectName: string;
  className: string | null;
  scheduledAt: Date | null;
  isPractice: boolean;
  status: string;
};

export type RecentSitting = {
  id: number;
  subjectName: string;
  className: string | null;
  isPractice: boolean;
  sat: number;
  graded: number;
  pct: number;
};

export type ExamOfficeDashboard = {
  heading: string;
  subheading: string;
  stats: {
    questions: number;
    papers: number;
    published: number;
    sat: number;
    theoryPending: number;
  };
  pipeline: PipelineStage[];
  upcoming: UpcomingPaper[];
  recentSittings: RecentSitting[];
};

/** legacy: $educbt_heading (exams/index.php) */
function headingFor(role: string): { heading: string; subheading: string } {
  if (role === 'exam_officer') {
    return { heading: 'Examination Officer Dashboard', subheading: 'Exam papers, CA tests, marking progress, and upcoming schedule' };
  }
  if (role === 'vice_principal') {
    return { heading: 'Vice Principal — Examinations', subheading: 'Exam papers, CA tests, marking progress, and upcoming schedule' };
  }
  return { heading: 'Examinations', subheading: 'Exam papers, CA tests, marking progress, and upcoming schedule' };
}

const SAT_STATUSES: ('submitted' | 'auto_submitted')[] = ['submitted', 'auto_submitted'];

export async function examOfficeDashboard(actor: Actor): Promise<ExamOfficeDashboard> {
  const { heading, subheading } = headingFor(actor.role);

  return forSchool(actor.schoolId, async (tx) => {
    // ── Stat tiles ─────────────────────────────────────────────────────────
    const [questionsRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.questions)
      .where(and(eq(schema.questions.schoolId, actor.schoolId), eq(schema.questions.status, 'active')));

    const [papersRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.examPapers)
      .where(and(eq(schema.examPapers.schoolId, actor.schoolId), ne(schema.examPapers.status, 'cancelled')));

    const [publishedRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.examPapers)
      .where(and(eq(schema.examPapers.schoolId, actor.schoolId), eq(schema.examPapers.status, 'published')));

    // "Sat & graded" — an attempt that has finished sitting AND has no theory
    // answer still waiting on a marker. Next has no `attempts.status = 'graded'`
    // (objective marks land at submission; theory needs a person) so this is the
    // Next-schema equivalent of the legacy count.
    const [satRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.attempts)
      .where(and(
        eq(schema.attempts.schoolId, actor.schoolId),
        inArray(schema.attempts.status, SAT_STATUSES),
        sql`NOT EXISTS (
          SELECT 1 FROM ${schema.attemptAnswers} a
          INNER JOIN ${schema.questions} q ON q.id = a.question_id
          WHERE a.attempt_id = ${schema.attempts.id} AND q.question_type = 'theory' AND a.awarded_marks IS NULL
        )`,
      ));

    const [theoryRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.attemptAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
      .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
      .where(and(
        eq(schema.attemptAnswers.schoolId, actor.schoolId),
        eq(schema.questions.questionType, 'theory'),
        isNull(schema.attemptAnswers.awardedMarks),
        inArray(schema.attempts.status, SAT_STATUSES),
      ));

    const stats = {
      questions: questionsRow?.n ?? 0,
      papers: papersRow?.n ?? 0,
      published: publishedRow?.n ?? 0,
      sat: satRow?.n ?? 0,
      theoryPending: theoryRow?.n ?? 0,
    };

    // ── Next papers (upcoming, scheduled from yesterday onward) ────────────
    const upcomingRows = await tx.select({
      id: schema.examPapers.id,
      subjectName: schema.subjects.name,
      className: schema.classes.displayName,
      scheduledAt: schema.examPapers.scheduledAt,
      isPractice: sql<boolean>`${schema.examSeries.seriesType} = 'practice'`,
      status: schema.examPapers.status,
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .where(and(
        eq(schema.examPapers.schoolId, actor.schoolId),
        ne(schema.examPapers.status, 'cancelled'),
        sql`${schema.examPapers.scheduledAt} >= now() - interval '1 day'`,
      ))
      .orderBy(schema.examPapers.scheduledAt)
      .limit(12);

    // ── Recent sittings (papers with at least one attempt) ─────────────────
    const recentRows = await tx.select({
      id: schema.examPapers.id,
      subjectName: schema.subjects.name,
      className: schema.classes.displayName,
      isPractice: sql<boolean>`${schema.examSeries.seriesType} = 'practice'`,
      scheduledAt: schema.examPapers.scheduledAt,
      sat: sql<number>`count(${schema.attempts.id})`.mapWith(Number),
      graded: sql<number>`sum(case when ${schema.attempts.status} in ('submitted','auto_submitted') then 1 else 0 end)`.mapWith(Number),
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .leftJoin(schema.attempts, eq(schema.attempts.paperId, schema.examPapers.id))
      .where(and(eq(schema.examPapers.schoolId, actor.schoolId), ne(schema.examPapers.status, 'cancelled')))
      .groupBy(schema.examPapers.id, schema.subjects.name, schema.classes.displayName, schema.examSeries.seriesType, schema.examPapers.scheduledAt)
      .having(sql`count(${schema.attempts.id}) > 0`)
      .orderBy(desc(schema.examPapers.scheduledAt))
      .limit(8);

    const recentSittings: RecentSitting[] = recentRows.map((r) => ({
      id: r.id,
      subjectName: r.subjectName,
      className: r.className,
      isPractice: r.isPractice,
      sat: r.sat,
      graded: r.graded,
      pct: r.sat > 0 ? Math.round((r.graded / r.sat) * 100) : 0,
    }));

    // ── Pipeline — "this term's examination" ────────────────────────────────
    const sessionId = await currentSessionId(tx, actor.schoolId);
    const [term] = await tx.select({ id: schema.terms.id })
      .from(schema.terms)
      .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.sessionId, sessionId), eq(schema.terms.isCurrent, true)))
      .limit(1);
    const termId = term?.id ?? 0;

    const [setCounts] = await tx.select({
      drafting: sql<number>`sum(case when ${schema.questionSets.status} = 'draft' then 1 else 0 end)`.mapWith(Number),
      awaiting: sql<number>`sum(case when ${schema.questionSets.status} in ('submitted','under_review') then 1 else 0 end)`.mapWith(Number),
      returned: sql<number>`sum(case when ${schema.questionSets.status} = 'returned' then 1 else 0 end)`.mapWith(Number),
      approved: sql<number>`sum(case when ${schema.questionSets.status} in ('approved','published') then 1 else 0 end)`.mapWith(Number),
      total: sql<number>`count(*)`.mapWith(Number),
    })
      .from(schema.questionSets)
      .where(and(eq(schema.questionSets.schoolId, actor.schoolId), eq(schema.questionSets.sessionId, sessionId), eq(schema.questionSets.termId, termId)));

    const drafting = setCounts?.drafting ?? 0;
    const awaiting = setCounts?.awaiting ?? 0;
    const returned = setCounts?.returned ?? 0;
    const approved = setCounts?.approved ?? 0;
    const total = setCounts?.total ?? 0;

    const [series] = await tx.select({ id: schema.examSeries.id, title: schema.examSeries.title, status: schema.examSeries.status })
      .from(schema.examSeries)
      .where(and(eq(schema.examSeries.schoolId, actor.schoolId), eq(schema.examSeries.sessionId, sessionId), eq(schema.examSeries.termId, termId)))
      .orderBy(desc(schema.examSeries.id))
      .limit(1);

    const seriesId = series?.id ?? 0;

    let scheduled = 0;
    let unpublished = 0;
    if (seriesId > 0) {
      const [schedRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.examPapers)
        .where(and(eq(schema.examPapers.schoolId, actor.schoolId), eq(schema.examPapers.seriesId, seriesId), ne(schema.examPapers.status, 'cancelled')));
      scheduled = schedRow?.n ?? 0;

      const [draftRow] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.examPapers)
        .where(and(eq(schema.examPapers.schoolId, actor.schoolId), eq(schema.examPapers.seriesId, seriesId), eq(schema.examPapers.status, 'draft')));
      unpublished = draftRow?.n ?? 0;
    }

    const released = seriesId > 0 && series?.status === 'published';
    const theoryLeft = stats.theoryPending;
    const satCount = stats.sat;

    const pipeline: PipelineStage[] = [
      {
        label: 'Questions submitted',
        state: drafting > 0 ? 'wait' : total > 0 ? 'done' : 'idle',
        note: drafting > 0
          ? `${drafting} subject(s) still being written by teachers`
          : total > 0 ? 'Every started subject has been handed in' : 'No subject has been started yet',
        href: '/portal/exams/approvals',
        action: 'View queue',
      },
      {
        label: 'Reviewed and approved',
        state: awaiting > 0 ? 'act' : approved > 0 ? 'done' : 'idle',
        note: awaiting > 0
          ? `${awaiting} subject(s) waiting on your decision`
          : returned > 0
            ? `${approved} approved · ${returned} sent back and not yet resubmitted`
            : approved > 0 ? `${approved} subject(s) approved` : 'Nothing approved yet',
        href: '/portal/exams/approvals',
        action: awaiting > 0 ? 'Review now' : 'Open approvals',
      },
      {
        label: 'Examination created',
        state: seriesId > 0 ? 'done' : 'act',
        note: seriesId > 0 ? series!.title : 'No examination exists for this term yet',
        href: seriesId > 0 ? `/portal/exams/${seriesId}` : '/portal/exams/new',
        action: seriesId > 0 ? 'Open' : 'Create examination',
      },
      {
        label: 'Timetable built',
        state: scheduled > 0 ? 'done' : approved > 0 ? 'act' : 'idle',
        note: scheduled > 0
          ? `${scheduled} paper(s) scheduled`
          : approved > 0 ? 'Approved questions are ready to be scheduled' : 'Nothing approved to schedule yet',
        href: seriesId > 0 ? `/portal/exams/${seriesId}` : '/portal/timetable',
        action: scheduled > 0 ? 'Adjust' : 'Generate schedule',
      },
      {
        label: 'Released to class teachers',
        state: released ? 'done' : scheduled > 0 ? 'act' : 'idle',
        note: released
          ? 'Class teachers can see their own schedule'
          : scheduled > 0 ? 'Built but not yet sent — teachers cannot see it' : 'Nothing to release yet',
        href: '/portal/timetable',
        action: 'Open timetable',
      },
      {
        label: 'Papers published',
        state: scheduled > 0 && unpublished === 0 ? 'done' : scheduled > 0 ? 'act' : 'idle',
        note: scheduled > 0
          ? unpublished === 0 ? 'All papers are live for students' : `${unpublished} paper(s) still in draft — students cannot open them`
          : 'No papers yet',
        href: seriesId > 0 ? `/portal/exams/${seriesId}` : '/portal/exams',
        action: 'Open papers',
      },
      {
        label: 'Marking complete',
        state: satCount > 0 ? (theoryLeft > 0 ? 'act' : 'done') : 'idle',
        note: satCount > 0
          ? theoryLeft > 0 ? `${theoryLeft} written answer(s) still to be marked` : 'Every written answer has been marked'
          : 'No paper has been sat yet',
        href: '/portal/marking',
        action: 'Marking status',
      },
    ];

    return {
      heading,
      subheading,
      stats,
      pipeline,
      upcoming: upcomingRows,
      recentSittings,
    };
  });
}
