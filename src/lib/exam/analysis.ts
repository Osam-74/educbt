/**
 * Subject Results — a subject teacher's read-only view of how their students
 * did on one assessment component (legacy templates/portal/teacher/analysis.php
 * + responses.php). Distinct from Record Scores (lib/ca/queries.ts), which is
 * where the numbers are typed in — this page only ranks and explains them.
 *
 * Two modes, one page:
 *  - A CA/assignment component reads assessment_scores (what the teacher entered).
 *  - The exam component reads CBT attempts (what the platform auto-marked,
 *    plus whatever theory marking has landed so far).
 *
 * SCHEMA HONESTY NOTE: unlike the legacy plugin, assessment_scores here carries
 * no attempt_id/source column — a CA test taken on the CBT engine is written by
 * a person the same as one taken on paper. So the "CBT" pill and the per-question
 * "Preview" only ever apply to the exam component, which is genuinely CBT-marked.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { caAssignment, canEnterCa, caSchool } from '@/lib/ca/access';
import { caComponentsAll } from '@/lib/ca/validation';
import type { AssessmentComponent } from '@/domain/academic';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const analysisScopeSchema = z.object({
  classId: id, subjectId: id, componentKey: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
});
export type AnalysisScope = z.infer<typeof analysisScopeSchema>;

export type AnalysisPair = { classId: number; className: string; subjectId: number; subjectName: string };

/** The (class, subject) pairs this actor may view, and the configured components — same access rule as Record Scores. */
export async function analysisOptions(actor: Actor): Promise<{ pairs: AnalysisPair[]; components: AssessmentComponent[] } | null> {
  if (!canEnterCa(actor)) return null;
  return forSchool(actor.schoolId, async (tx) => {
    const school = await caSchool(tx, actor);
    if (!school) return null;
    const pairs = await tx.select({
      classId: schema.classes.id, className: schema.classes.displayName,
      subjectId: schema.subjects.id, subjectName: schema.subjects.name,
    }).from(schema.classes).innerJoin(schema.subjects, eq(schema.subjects.schoolId, actor.schoolId))
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active'),
        eq(schema.subjects.status, 'active'), caAssignment(tx, actor, schema.classes.id, schema.subjects.id)))
      .orderBy(asc(schema.classes.displayName), asc(schema.subjects.name));
    return {
      pairs: pairs.map((p) => ({ ...p, classId: Number(p.classId), subjectId: Number(p.subjectId) })),
      components: caComponentsAll(school.settings),
    };
  });
}

export type AnalysisRow = {
  studentId: number; name: string; admissionNumber: string;
  score: number; maxScore: number; percentage: number; position: number;
  cbt: boolean; attemptId: number | null;
};
export type AnalysisStats = { count: number; average: number; highest: number; passRate: number };
export type HardestQuestion = { questionId: number; text: string; answered: number; correct: number; rate: number };

export type AnalysisResult = {
  className: string; subjectName: string; sessionTitle: string; termTitle: string;
  component: AssessmentComponent; rows: AnalysisRow[]; stats: AnalysisStats;
  hardestQuestions: HardestQuestion[];
  /** Attempts sat but not yet fully marked (theory pending) — excluded from ranking, called out separately. */
  pendingCount: number;
};

export async function subjectAnalysis(
  actor: Actor, scope: AnalysisScope,
): Promise<AnalysisResult | { noTerm: true } | { noConfig: true } | { noComponent: true } | null> {
  if (!canEnterCa(actor) || !analysisScopeSchema.safeParse(scope).success) return null;
  return forSchool(actor.schoolId, async (tx) => {
    const school = await caSchool(tx, actor);
    if (!school) return null;
    const components = caComponentsAll(school.settings);
    if (!components.length) return { noConfig: true as const };
    const component = components.find((c) => c.key === scope.componentKey);
    if (!component) return { noComponent: true as const };

    const [term] = await tx.select({ id: schema.terms.id, title: schema.terms.title, sessionId: schema.terms.sessionId })
      .from(schema.terms).where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true))).limit(1);
    if (!term) return { noTerm: true as const };
    const [session] = await tx.select({ title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.id, term.sessionId)).limit(1);

    const [context] = await tx.select({
      className: schema.classes.displayName, subjectName: schema.subjects.name,
      levelId: schema.classes.levelId, departmentId: schema.classes.departmentId,
    }).from(schema.classes)
      .innerJoin(schema.subjects, and(eq(schema.subjects.id, scope.subjectId), eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .where(and(eq(schema.classes.id, scope.classId), eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.status, 'active'), caAssignment(tx, actor, scope.classId, scope.subjectId))).limit(1);
    if (!context) return null;

    const students = await tx.select({
      studentId: schema.students.id, firstName: schema.students.firstName, lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber,
    }).from(schema.students)
      .innerJoin(schema.enrollments, and(eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, scope.classId),
        eq(schema.enrollments.sessionId, term.sessionId), eq(schema.enrollments.status, 'active')))
      .innerJoin(schema.studentSubjects, and(eq(schema.studentSubjects.studentId, schema.students.id),
        eq(schema.studentSubjects.schoolId, actor.schoolId), eq(schema.studentSubjects.subjectId, scope.subjectId),
        eq(schema.studentSubjects.sessionId, term.sessionId)))
      .where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')));
    const ids = students.map((s) => Number(s.studentId));
    const byId = new Map(students.map((s) => [Number(s.studentId), s]));

    const rows: AnalysisRow[] = [];
    let hardestQuestions: HardestQuestion[] = [];
    let pendingCount = 0;

    if (component.isExam) {
      // Same matching fallback the timetable, compile and Record Scores use:
      // exact class, or the class's level (+ department, if it has one).
      const papers = await tx.select({
        id: schema.examPapers.id, classId: schema.examPapers.classId,
        levelId: schema.examPapers.levelId, departmentId: schema.examPapers.departmentId,
      }).from(schema.examPapers).innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
        .where(and(eq(schema.examPapers.schoolId, actor.schoolId), eq(schema.examPapers.subjectId, scope.subjectId),
          eq(schema.examSeries.sessionId, term.sessionId), eq(schema.examSeries.termId, term.id),
          eq(schema.examSeries.seriesType, 'examination'), inArray(schema.examPapers.status, ['published', 'closed'])));
      const matching = papers.filter((p) => p.classId === scope.classId || (p.classId === null && p.levelId === context.levelId
        && (context.departmentId ? (p.departmentId === null || p.departmentId === context.departmentId) : p.departmentId === null)));
      const examPaperId = matching.length === 1 ? Number(matching[0]!.id) : null;

      if (examPaperId && ids.length) {
        const attemptsRaw = (await tx.select({
          id: schema.attempts.id, studentId: schema.attempts.studentId, questionOrder: schema.attempts.questionOrder,
        }).from(schema.attempts).where(and(eq(schema.attempts.paperId, examPaperId), inArray(schema.attempts.studentId, ids),
          inArray(schema.attempts.status, ['submitted', 'auto_submitted']))))
          .map((a) => ({ id: Number(a.id), studentId: Number(a.studentId), questionOrder: (a.questionOrder ?? []) as number[] }));
        const attemptIds = attemptsRaw.map((a) => a.id);

        const answerRows = attemptIds.length ? (await tx.select({
          attemptId: schema.attemptAnswers.attemptId, questionId: schema.questions.id,
          marks: schema.questions.marks, awarded: schema.attemptAnswers.awardedMarks,
        }).from(schema.attemptAnswers).innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
          .where(inArray(schema.attemptAnswers.attemptId, attemptIds)))
          .map((r) => ({ attemptId: Number(r.attemptId), questionId: Number(r.questionId), marks: Number(r.marks), awarded: r.awarded === null ? null : Number(r.awarded) })) : [];

        for (const a of attemptsRaw) {
          const student = byId.get(a.studentId);
          if (!student) continue;
          const selected = a.questionOrder.map((qid) => answerRows.find((r) => r.attemptId === a.id && r.questionId === qid));
          const graded = selected.length > 0 && selected.every((r) => r && r.awarded !== null);
          if (!graded) { pendingCount += 1; continue; }
          const maximum = selected.reduce((sum, r) => sum + r!.marks, 0);
          const awarded = selected.reduce((sum, r) => sum + r!.awarded!, 0);
          const percentage = maximum > 0 ? Math.round((awarded / maximum) * 1000) / 10 : 0;
          rows.push({
            studentId: a.studentId, name: `${student.firstName} ${student.lastName}`, admissionNumber: student.admissionNumber,
            score: awarded, maxScore: maximum, percentage, position: 0, cbt: true, attemptId: a.id,
          });
        }

        // Hardest questions — objective only. Marks are final at submit time for
        // these (engine.ts marks them there and then), so partial theory marking
        // elsewhere in the paper doesn't hold this section back.
        if (attemptIds.length) {
          const objectiveRows = await tx.select({
            questionId: schema.questions.id, text: schema.questions.questionText, marks: schema.questions.marks,
            awarded: schema.attemptAnswers.awardedMarks,
          }).from(schema.attemptAnswers)
            .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
            .where(and(inArray(schema.attemptAnswers.attemptId, attemptIds), sql`${schema.questions.questionType} <> 'theory'`));
          const byQuestion = new Map<number, { text: string; answered: number; correct: number }>();
          for (const r of objectiveRows) {
            const qid = Number(r.questionId);
            const entry = byQuestion.get(qid) ?? { text: r.text, answered: 0, correct: 0 };
            entry.answered += 1;
            if (r.awarded !== null && Number(r.marks) > 0 && Number(r.awarded) >= Number(r.marks)) entry.correct += 1;
            byQuestion.set(qid, entry);
          }
          hardestQuestions = [...byQuestion.entries()]
            .map(([questionId, v]) => ({
              questionId, text: v.text, answered: v.answered, correct: v.correct,
              rate: v.answered > 0 ? Math.round((v.correct / v.answered) * 100) : 0,
            }))
            .filter((q) => q.answered > 0)
            .sort((a, b) => a.rate - b.rate)
            .slice(0, 10);
        }
      }
    } else {
      const scores = ids.length ? await tx.select({
        studentId: schema.assessmentScores.studentId, score: schema.assessmentScores.score, maxScore: schema.assessmentScores.maxScore,
      }).from(schema.assessmentScores).where(and(inArray(schema.assessmentScores.studentId, ids),
        eq(schema.assessmentScores.schoolId, actor.schoolId), eq(schema.assessmentScores.subjectId, scope.subjectId),
        eq(schema.assessmentScores.sessionId, term.sessionId), eq(schema.assessmentScores.termId, term.id),
        eq(schema.assessmentScores.componentKey, scope.componentKey))) : [];
      for (const s of scores) {
        const student = byId.get(Number(s.studentId));
        if (!student) continue;
        const score = Number(s.score); const maxScore = Number(s.maxScore);
        const percentage = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
        rows.push({
          studentId: Number(s.studentId), name: `${student.firstName} ${student.lastName}`, admissionNumber: student.admissionNumber,
          score, maxScore, percentage, position: 0, cbt: false, attemptId: null,
        });
      }
    }

    // Rank highest first; equal marks share a position (legacy parity).
    rows.sort((a, b) => b.percentage - a.percentage || byId.get(a.studentId)!.lastName.localeCompare(byId.get(b.studentId)!.lastName));
    let position = 0; let previous: number | null = null;
    rows.forEach((r, i) => {
      if (previous === null || Math.abs(r.percentage - previous) > 0.0001) position = i + 1;
      previous = r.percentage; r.position = position;
    });

    const stats: AnalysisStats = rows.length ? {
      count: rows.length,
      average: Math.round((rows.reduce((sum, r) => sum + r.percentage, 0) / rows.length) * 10) / 10,
      highest: Math.round(Math.max(...rows.map((r) => r.percentage)) * 10) / 10,
      passRate: Math.round((rows.filter((r) => r.percentage >= 40).length / rows.length) * 100),
    } : { count: 0, average: 0, highest: 0, passRate: 0 };

    return {
      className: context.className, subjectName: context.subjectName,
      sessionTitle: session?.title ?? '', termTitle: term.title,
      component, rows, stats, hardestQuestions, pendingCount,
    };
  });
}

// ── Response preview ─────────────────────────────────────────────────────────

export type ResponseOption = { id: number; text: string; imageUrl: string | null; isCorrect: boolean; chosen: boolean };
export type ResponseQuestion = {
  number: number; questionId: number; text: string; imageUrl: string | null; type: string; marks: number;
  awarded: number | null; passageTitle: string | null; passageBody: string | null;
  options: ResponseOption[]; textAnswer: string | null;
};
export type AttemptResponses = {
  studentName: string; admissionNumber: string; subjectName: string; typeLabel: string;
  status: string; submittedAt: string | null; score: number; maxScore: number; percentage: number;
  questions: ResponseQuestion[];
};

/** A student's exam responses — reached only via the "Preview" link on their own Subject Results row. */
export async function attemptResponses(actor: Actor, attemptId: number): Promise<AttemptResponses | null> {
  if (!canEnterCa(actor) || !Number.isInteger(attemptId) || attemptId <= 0) return null;
  return forSchool(actor.schoolId, async (tx) => {
    const [attempt] = await tx.select({
      id: schema.attempts.id, studentId: schema.attempts.studentId, paperId: schema.attempts.paperId,
      status: schema.attempts.status, submittedAt: schema.attempts.submittedAt, questionOrder: schema.attempts.questionOrder,
    }).from(schema.attempts).where(and(eq(schema.attempts.id, attemptId), eq(schema.attempts.schoolId, actor.schoolId))).limit(1);
    if (!attempt) return null;

    const [paperCtx] = await tx.select({
      subjectId: schema.examPapers.subjectId, classId: schema.examPapers.classId,
      seriesType: schema.examSeries.seriesType, subjectName: schema.subjects.name,
    }).from(schema.examPapers).innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .where(eq(schema.examPapers.id, attempt.paperId)).limit(1);
    if (!paperCtx) return null;

    // Gate: this teacher must hold the student's own class + this subject. The
    // paper's classId may be null (a level/department-wide paper), so resolve
    // the class from the student's actual current enrollment.
    const [enroll] = await tx.select({ classId: schema.enrollments.classId })
      .from(schema.enrollments).where(and(eq(schema.enrollments.studentId, attempt.studentId),
        eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.status, 'active'))).limit(1);
    const classId = paperCtx.classId ?? enroll?.classId ?? null;
    if (classId === null) return null;
    const [allowed] = await tx.select({ one: sql`1` }).from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId),
        caAssignment(tx, actor, classId, Number(paperCtx.subjectId)))).limit(1);
    if (!allowed) return null;

    const [student] = await tx.select({
      firstName: schema.students.firstName, lastName: schema.students.lastName, admissionNumber: schema.students.admissionNumber,
    }).from(schema.students).where(eq(schema.students.id, attempt.studentId)).limit(1);
    if (!student) return null;

    const order = (attempt.questionOrder ?? []) as number[];
    const questionRows = order.length ? await tx.select({
      id: schema.questions.id, text: schema.questions.questionText, imageUrl: schema.questions.imageUrl,
      type: schema.questions.questionType, marks: schema.questions.marks, passageId: schema.questions.passageId,
    }).from(schema.questions).where(inArray(schema.questions.id, order)) : [];
    const questionById = new Map(questionRows.map((q) => [Number(q.id), q]));

    const optionRows = order.length ? await tx.select({
      id: schema.questionOptions.id, questionId: schema.questionOptions.questionId, text: schema.questionOptions.optionText,
      imageUrl: schema.questionOptions.imageUrl, isCorrect: schema.questionOptions.isCorrect,
    }).from(schema.questionOptions).where(inArray(schema.questionOptions.questionId, order))
      .orderBy(asc(schema.questionOptions.sortOrder)) : [];
    const optionsByQ = new Map<number, typeof optionRows>();
    for (const o of optionRows) {
      const qid = Number(o.questionId);
      optionsByQ.set(qid, [...(optionsByQ.get(qid) ?? []), o]);
    }

    const answerRows = await tx.select({
      questionId: schema.attemptAnswers.questionId, optionId: schema.attemptAnswers.optionId,
      textAnswer: schema.attemptAnswers.textAnswer, awardedMarks: schema.attemptAnswers.awardedMarks,
    }).from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, attempt.id));
    const answerByQ = new Map(answerRows.map((a) => [Number(a.questionId), a]));

    const passageIds = [...new Set(questionRows.map((q) => q.passageId).filter((p): p is number => p !== null).map(Number))];
    const passages = passageIds.length ? await tx.select({ id: schema.passages.id, title: schema.passages.title, body: schema.passages.body })
      .from(schema.passages).where(inArray(schema.passages.id, passageIds)) : [];
    const passageById = new Map(passages.map((p) => [Number(p.id), p]));

    let score = 0; let maxScore = 0;
    const questions: ResponseQuestion[] = order.map((qid, i) => {
      const q = questionById.get(qid);
      const ans = answerByQ.get(qid);
      const marks = q ? Number(q.marks) : 0;
      const awarded = ans && ans.awardedMarks !== null ? Number(ans.awardedMarks) : null;
      maxScore += marks; if (awarded !== null) score += awarded;
      const opts = optionsByQ.get(qid) ?? [];
      const passage = q?.passageId ? passageById.get(Number(q.passageId)) : null;
      return {
        number: i + 1, questionId: qid, text: q?.text ?? '', imageUrl: q?.imageUrl ?? null,
        type: q?.type ?? 'single_choice', marks, awarded,
        passageTitle: passage?.title ?? null, passageBody: passage?.body ?? null,
        options: opts.map((o) => ({
          id: Number(o.id), text: o.text, imageUrl: o.imageUrl, isCorrect: o.isCorrect,
          chosen: ans?.optionId !== null && ans?.optionId !== undefined && Number(ans.optionId) === Number(o.id),
        })),
        textAnswer: ans?.textAnswer ?? null,
      };
    });

    return {
      studentName: `${student.firstName} ${student.lastName}`, admissionNumber: student.admissionNumber,
      subjectName: paperCtx.subjectName, typeLabel: paperCtx.seriesType === 'examination' ? 'Examination' : 'CA Test',
      status: attempt.status, submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
      score, maxScore, percentage: maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0,
      questions,
    };
  });
}
