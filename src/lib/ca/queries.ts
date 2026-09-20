import { and, asc, eq, inArray } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { isEditable } from '@/domain/academic';
import { caAssignment, caSchool, canEnterCa } from './access';
import { caComponents, caComponentsAll, caScopeSchema, caSheetScopeSchema, type CaScope, type CaSheetScope } from './validation';

export async function caOptions(actor: Actor) {
  if (!canEnterCa(actor)) return null;
  return forSchool(actor.schoolId, async tx => {
    const school = await caSchool(tx, actor);
    if (!school) return null;
    const sessions = await tx.select({ id: schema.academicSessions.id, title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.title));
    const terms = await tx.select({ id: schema.terms.id, sessionId: schema.terms.sessionId, title: schema.terms.title })
      .from(schema.terms).where(eq(schema.terms.schoolId, actor.schoolId)).orderBy(asc(schema.terms.position));
    const pairs = await tx.select({
      classId: schema.classes.id, className: schema.classes.displayName,
      subjectId: schema.subjects.id, subjectName: schema.subjects.name, subjectCode: schema.subjects.code,
    }).from(schema.classes).innerJoin(schema.subjects, eq(schema.subjects.schoolId, actor.schoolId))
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active'),
        eq(schema.subjects.status, 'active'), caAssignment(tx, actor, schema.classes.id, schema.subjects.id)))
      .orderBy(asc(schema.classes.displayName), asc(schema.subjects.name));
    return { sessions, terms, pairs, components: caComponents(school.settings) };
  });
}

export async function caRoster(actor: Actor, scope: CaScope) {
  if (!canEnterCa(actor) || !caScopeSchema.safeParse(scope).success) return null;
  return forSchool(actor.schoolId, async tx => {
    const school = await caSchool(tx, actor);
    const component = school && caComponents(school.settings).find(c => c.key === scope.componentKey);
    if (!component) return null;
    const [context] = await tx.select({
      className: schema.classes.displayName, subjectName: schema.subjects.name,
      sessionTitle: schema.academicSessions.title, termTitle: schema.terms.title,
    }).from(schema.classes)
      .innerJoin(schema.subjects, and(eq(schema.subjects.id, scope.subjectId), eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .innerJoin(schema.academicSessions, and(eq(schema.academicSessions.id, scope.sessionId), eq(schema.academicSessions.schoolId, actor.schoolId)))
      .innerJoin(schema.terms, and(eq(schema.terms.id, scope.termId), eq(schema.terms.sessionId, scope.sessionId), eq(schema.terms.schoolId, actor.schoolId)))
      .where(and(eq(schema.classes.id, scope.classId), eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.status, 'active'), caAssignment(tx, actor, scope.classId, scope.subjectId))).limit(1);
    if (!context) return null;
    const rows = await tx.select({
      studentId: schema.students.id, firstName: schema.students.firstName, lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber, score: schema.assessmentScores.score,
      updatedAt: schema.assessmentScores.updatedAt, state: schema.subjectResults.state,
      published: schema.subjectResults.published,
    }).from(schema.students)
      .innerJoin(schema.enrollments, and(eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, scope.classId),
        eq(schema.enrollments.sessionId, scope.sessionId), eq(schema.enrollments.status, 'active')))
      .innerJoin(schema.studentSubjects, and(eq(schema.studentSubjects.studentId, schema.students.id),
        eq(schema.studentSubjects.schoolId, actor.schoolId), eq(schema.studentSubjects.subjectId, scope.subjectId),
        eq(schema.studentSubjects.sessionId, scope.sessionId)))
      .leftJoin(schema.assessmentScores, and(eq(schema.assessmentScores.schoolId, actor.schoolId),
        eq(schema.assessmentScores.studentId, schema.students.id), eq(schema.assessmentScores.subjectId, scope.subjectId),
        eq(schema.assessmentScores.sessionId, scope.sessionId), eq(schema.assessmentScores.termId, scope.termId),
        eq(schema.assessmentScores.componentKey, scope.componentKey)))
      .leftJoin(schema.subjectResults, and(eq(schema.subjectResults.schoolId, actor.schoolId),
        eq(schema.subjectResults.studentId, schema.students.id), eq(schema.subjectResults.subjectId, scope.subjectId),
        eq(schema.subjectResults.sessionId, scope.sessionId), eq(schema.subjectResults.termId, scope.termId)))
      .where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName), asc(schema.students.admissionNumber));
    return { ...context, component, rows: rows.map(row => ({
      ...row, editable: !row.published && (row.state === null || isEditable(row.state)),
    })) };
  });
}

export type CaSheetCell = { score: number | null; editable: boolean; waiting?: string };
export type CaSheetRow = {
  studentId: number; firstName: string; lastName: string; admissionNumber: string;
  cells: Record<string, CaSheetCell>; total: number; editable: boolean;
};

/**
 * The whole score sheet for one class + subject, current term: every CA/
 * assignment component as an editable column, plus (when a terminal exam
 * paper has been published for this subject/class) an exam column too —
 * ported from the plugin's teacher/scores.php, which puts every component
 * on one screen with a single Save.
 *
 * The exam column's source depends on how that paper is delivered: a CBT
 * paper is read-only here, sourced from the marked attempt; a written paper
 * has no attempt at all, so its column is editable exactly like a CA
 * component and saved the same way (see the exam-key allowance in
 * lib/ca/access.ts validateCaContext).
 */
export async function caFullSheet(actor: Actor, scope: CaSheetScope) {
  if (!canEnterCa(actor) || !caSheetScopeSchema.safeParse(scope).success) return null;
  return forSchool(actor.schoolId, async tx => {
    const school = await caSchool(tx, actor);
    if (!school) return null;
    const configuredComponents = caComponentsAll(school.settings);
    if (!configuredComponents.length) return { noTerm: false as const, noConfig: true as const };

    const [term] = await tx.select({ id: schema.terms.id, title: schema.terms.title, sessionId: schema.terms.sessionId })
      .from(schema.terms).where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true))).limit(1);
    if (!term) return { noTerm: true as const, noConfig: false as const };
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
      .where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    const ids = students.map(s => Number(s.studentId));
    const caComponentsList = configuredComponents.filter(c => !c.isExam);
    const examComponent = configuredComponents.find(c => c.isExam) ?? null;

    const scores = ids.length ? await tx.select().from(schema.assessmentScores).where(and(
      inArray(schema.assessmentScores.studentId, ids), eq(schema.assessmentScores.schoolId, actor.schoolId),
      eq(schema.assessmentScores.subjectId, scope.subjectId), eq(schema.assessmentScores.sessionId, term.sessionId),
      eq(schema.assessmentScores.termId, term.id))) : [];

    const stateRows = ids.length ? await tx.select({
      studentId: schema.subjectResults.studentId, state: schema.subjectResults.state, published: schema.subjectResults.published,
    }).from(schema.subjectResults).where(and(inArray(schema.subjectResults.studentId, ids), eq(schema.subjectResults.schoolId, actor.schoolId),
      eq(schema.subjectResults.subjectId, scope.subjectId), eq(schema.subjectResults.sessionId, term.sessionId),
      eq(schema.subjectResults.termId, term.id))) : [];

    // Only show the exam column when exactly one published/closed terminal
    // paper matches this subject in this class (directly, or via level +
    // department, same fallback the timetable and compile use).
    let examPaperId: number | null = null;
    let examPaperWritten = false;
    if (examComponent) {
      const papers = await tx.select({ id: schema.examPapers.id, classId: schema.examPapers.classId,
        levelId: schema.examPapers.levelId, departmentId: schema.examPapers.departmentId,
        deliveryMode: schema.examPapers.deliveryMode })
        .from(schema.examPapers).innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
        .where(and(eq(schema.examPapers.schoolId, actor.schoolId), eq(schema.examPapers.subjectId, scope.subjectId),
          eq(schema.examSeries.sessionId, term.sessionId), eq(schema.examSeries.termId, term.id),
          eq(schema.examSeries.seriesType, 'examination'), inArray(schema.examPapers.status, ['published', 'closed'])));
      const matching = papers.filter(p => p.classId === scope.classId || (p.classId === null && p.levelId === context.levelId
        && (context.departmentId ? (p.departmentId === null || p.departmentId === context.departmentId) : p.departmentId === null)));
      if (matching.length === 1) { examPaperId = Number(matching[0]!.id); examPaperWritten = matching[0]!.deliveryMode === 'written'; }
    }

    let attempts: Array<{ id: number; studentId: number; status: string; questionOrder: number[] }> = [];
    let answers: Array<{ attemptId: number; questionId: number; marks: string; awarded: string | null }> = [];
    if (examPaperId && ids.length && !examPaperWritten) {
      attempts = (await tx.select({ id: schema.attempts.id, studentId: schema.attempts.studentId,
        status: schema.attempts.status, questionOrder: schema.attempts.questionOrder })
        .from(schema.attempts).where(and(eq(schema.attempts.paperId, examPaperId), inArray(schema.attempts.studentId, ids))))
        .map(a => ({ ...a, id: Number(a.id), studentId: Number(a.studentId) }));
      const attemptIds = attempts.map(a => a.id);
      answers = attemptIds.length ? (await tx.select({ attemptId: schema.attemptAnswers.attemptId,
        questionId: schema.questions.id, marks: schema.questions.marks, awarded: schema.attemptAnswers.awardedMarks })
        .from(schema.attemptAnswers).innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
        .where(inArray(schema.attemptAnswers.attemptId, attemptIds)))
        .map(a => ({ ...a, attemptId: Number(a.attemptId), questionId: Number(a.questionId) })) : [];
    }

    const components = examPaperId && examComponent ? [...caComponentsList, examComponent] : caComponentsList;

    const rows: CaSheetRow[] = students.map(s => {
      const sid = Number(s.studentId);
      const state = stateRows.find(r => Number(r.studentId) === sid);
      const editable = !state || (!state.published && isEditable(state.state));
      const cells: Record<string, CaSheetCell> = {};
      for (const c of caComponentsList) {
        const found = scores.find(sc => Number(sc.studentId) === sid && sc.componentKey === c.key);
        cells[c.key] = { score: found ? Number(found.score) : null, editable };
      }
      if (examPaperId && examComponent && examPaperWritten) {
        // Written: there is no attempt to read. The mark is typed in here,
        // stored exactly like a CA component (see enterScore's exam-key
        // allowance in lib/ca/access.ts).
        const found = scores.find(sc => Number(sc.studentId) === sid && sc.componentKey === examComponent.key);
        cells[examComponent.key] = { score: found ? Number(found.score) : null, editable };
      } else if (examPaperId && examComponent) {
        const attempt = attempts.find(a => a.studentId === sid);
        let score: number | null = null;
        let waiting = 'Not sat';
        if (attempt) {
          if (attempt.status === 'in_progress') waiting = 'Sitting now';
          else if (attempt.status === 'submitted' || attempt.status === 'auto_submitted') {
            const selected = attempt.questionOrder.map(qid => answers.find(a => a.attemptId === attempt.id && a.questionId === qid));
            const graded = selected.length > 0 && selected.every(a => a && a.awarded !== null);
            if (graded) {
              const maximum = selected.reduce((sum, a) => sum + Number(a!.marks), 0);
              const awarded = selected.reduce((sum, a) => sum + Number(a!.awarded), 0);
              score = maximum > 0 ? Math.round((awarded / maximum) * examComponent.maxScore * 100) / 100 : 0;
            } else waiting = 'Marking in progress';
          } else waiting = 'Not completed';
        }
        cells[examComponent.key] = { score, editable: false, waiting: score === null ? waiting : undefined };
      }
      const total = Object.values(cells).reduce((sum, c) => sum + (c.score ?? 0), 0);
      return { studentId: sid, firstName: s.firstName, lastName: s.lastName,
        admissionNumber: s.admissionNumber, cells, total, editable };
    });

    return {
      noTerm: false as const, noConfig: false as const,
      className: context.className, subjectName: context.subjectName,
      sessionTitle: session?.title ?? '', termTitle: term.title,
      sessionId: Number(term.sessionId), termId: Number(term.id),
      components, students: rows,
      // Only meaningful when an exam column is actually present; the sheet UI
      // uses it purely to caption that column correctly (CBT vs written).
      examDeliveryMode: examPaperId ? (examPaperWritten ? 'written' as const : 'cbt' as const) : null,
    };
  });
}
