import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, or, isNull } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { computeTotal, gradeFor, rank, canTransition, isEditable, requiresReason, type ResultState } from '@/domain/academic';
import { lockResultTerm } from '@/lib/ca/lock';
import { canManageResults, resultConfig, resultScopeSchema, resultStateSchema, type ResultScope } from './config';

export class ResultError extends Error {}
const fail = (message: string): never => { throw new ResultError(message); };
export async function resultAccess(tx: Tx, actor: Actor) {
  if (!canManageResults(actor)) fail('You do not have permission to manage results.');
  const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(
    eq(schema.users.id, actor.userId), eq(schema.users.schoolId, actor.schoolId),
    eq(schema.users.role, actor.role as 'principal'), eq(schema.users.status, 'active')));
  const [school] = await tx.select().from(schema.schools).where(and(
    eq(schema.schools.id, actor.schoolId), eq(schema.schools.status, 'active')));
  if (!user || !school) fail('This school account is unavailable.');
  return school!;
}

export async function resultOptions(actor: Actor) {
  return forSchool(actor.schoolId, async tx => {
    await resultAccess(tx, actor);
    const classes = await tx.select().from(schema.classes).where(eq(schema.classes.status, 'active')).orderBy(asc(schema.classes.displayName));
    const sessions = await tx.select().from(schema.academicSessions).orderBy(asc(schema.academicSessions.title));
    const terms = await tx.select().from(schema.terms).orderBy(asc(schema.terms.position));
    return { classes, sessions, terms };
  });
}

async function inputs(tx: Tx, actor: Actor, scope: ResultScope) {
  if (!resultScopeSchema.safeParse(scope).success) fail('Choose a valid class, session and term.');
  const school = await resultAccess(tx, actor);
  const [classroom] = await tx.select().from(schema.classes).where(and(eq(schema.classes.id, scope.classId), eq(schema.classes.status, 'active')));
  const [term] = await tx.select().from(schema.terms).where(and(eq(schema.terms.id, scope.termId), eq(schema.terms.sessionId, scope.sessionId)));
  const [session] = await tx.select().from(schema.academicSessions).where(eq(schema.academicSessions.id, scope.sessionId));
  if (!classroom || !term || !session) fail('This academic scope is unavailable.');
  const config = resultConfig(school.settings);
  const students = await tx.select({ id: schema.students.id, firstName: schema.students.firstName,
    lastName: schema.students.lastName, admissionNumber: schema.students.admissionNumber }).from(schema.enrollments)
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .where(and(eq(schema.enrollments.classId, scope.classId), eq(schema.enrollments.sessionId, scope.sessionId),
      eq(schema.enrollments.status, 'active'), eq(schema.students.status, 'active'))).orderBy(asc(schema.students.id));
  const ids = students.map(s => s.id);
  const offerings = ids.length ? await tx.select({ studentId: schema.studentSubjects.studentId,
    subjectId: schema.subjects.id, subjectName: schema.subjects.name }).from(schema.studentSubjects)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.studentSubjects.subjectId))
    .where(and(inArray(schema.studentSubjects.studentId, ids), eq(schema.studentSubjects.sessionId, scope.sessionId),
      eq(schema.subjects.status, 'active'))).orderBy(asc(schema.studentSubjects.studentId), asc(schema.subjects.id)) : [];
  const results = ids.length ? await tx.select().from(schema.subjectResults).where(and(
    inArray(schema.subjectResults.studentId, ids), eq(schema.subjectResults.sessionId, scope.sessionId),
    eq(schema.subjectResults.termId, scope.termId))).orderBy(asc(schema.subjectResults.id)) : [];
  const scores = ids.length ? await tx.select().from(schema.assessmentScores).where(and(
    inArray(schema.assessmentScores.studentId, ids), eq(schema.assessmentScores.sessionId, scope.sessionId),
    eq(schema.assessmentScores.termId, scope.termId))).orderBy(asc(schema.assessmentScores.id)) : [];
  const papers = await tx.select({ id: schema.examPapers.id, subjectId: schema.examPapers.subjectId }).from(schema.examPapers)
    .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId)).where(and(
      eq(schema.examSeries.sessionId, scope.sessionId), eq(schema.examSeries.termId, scope.termId),
      eq(schema.examSeries.seriesType, 'examination'), inArray(schema.examSeries.status, ['published', 'closed']),
      inArray(schema.examPapers.status, ['published', 'closed']),
      or(eq(schema.examPapers.classId, scope.classId), and(isNull(schema.examPapers.classId),
        eq(schema.examPapers.levelId, classroom!.levelId),
        classroom!.departmentId ? or(isNull(schema.examPapers.departmentId), eq(schema.examPapers.departmentId, classroom!.departmentId)) : isNull(schema.examPapers.departmentId)))))
    .orderBy(asc(schema.examPapers.id));
  const attempts = ids.length && papers.length ? await tx.select().from(schema.attempts).where(and(
    inArray(schema.attempts.studentId, ids), inArray(schema.attempts.paperId, papers.map(p => p.id))))
    .orderBy(asc(schema.attempts.id)) : [];
  const answers = attempts.length ? await tx.select({ attemptId: schema.attemptAnswers.attemptId,
    questionId: schema.questions.id, marks: schema.questions.marks, awarded: schema.attemptAnswers.awardedMarks })
    .from(schema.attemptAnswers).innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
    .where(inArray(schema.attemptAnswers.attemptId, attempts.map(a => a.id)))
    .orderBy(asc(schema.attemptAnswers.id)) : [];
  const rows = offerings.map(offering => {
    const missing: string[] = [];
    const components: Array<{ key: string; score: number }> = [];
    const caComponents = config?.assessmentComponents.filter(c => !c.isExam) ?? [];
    for (const component of caComponents) {
      const score = scores.find(s => s.studentId === offering.studentId && s.subjectId === offering.subjectId && s.componentKey === component.key);
      if (score && Number(score.maxScore) === component.maxScore && Number(score.score) >= 0 && Number(score.score) <= component.maxScore) {
        components.push({ key: component.key, score: Number(score.score) });
      } else missing.push(component.label);
    }
    const caComplete = caComponents.length > 0 && missing.length === 0;
    const examComponent = config?.assessmentComponents.find(c => c.isExam);
    const applicable = papers.filter(p => p.subjectId === offering.subjectId);
    let examComplete = false;
    if (applicable.length === 1 && examComponent) {
      const attempt = attempts.find(a => a.studentId === offering.studentId && a.paperId === applicable[0]!.id);
      if (attempt && ['submitted', 'auto_submitted'].includes(attempt.status) && attempt.questionOrder.length > 0) {
        const selected = attempt.questionOrder.map(id => answers.find(a => a.attemptId === attempt.id && a.questionId === id));
        if (selected.every(a => a && a.awarded !== null && Number(a.marks) > 0 && Number(a.awarded) >= 0 && Number(a.awarded) <= Number(a.marks))) {
          const maximum = selected.reduce((s, a) => s + Number(a!.marks), 0);
          const awarded = selected.reduce((s, a) => s + Number(a!.awarded), 0);
          components.push({ key: examComponent.key, score: Math.round(awarded / maximum * examComponent.maxScore * 100) / 100 });
          examComplete = true;
        }
      }
    }
    if (!examComplete) missing.push(applicable.length > 1 ? 'Multiple exam papers: aggregation policy required' : 'Examination missing or not fully marked');
    const total = computeTotal(config?.assessmentComponents ?? [], components);
    return { ...offering, ...total, complete: Boolean(config) && total.complete, missing,
      caComplete, examComplete, stored: results.find(r => r.studentId === offering.studentId && r.subjectId === offering.subjectId) ?? null };
  });
  // Fingerprint source values, not result lifecycle metadata. No credentials or personal names enter audit metadata.
  const fingerprint = createHash('sha256').update(JSON.stringify({ scope, config,
    students: students.map(s => ({ id: s.id, admissionNumber: s.admissionNumber })), offerings,
    scores: scores.map(s => [s.studentId, s.subjectId, s.componentKey, s.score, s.maxScore, s.updatedAt]),
    papers, attempts: attempts.map(a => [a.id, a.studentId, a.paperId, a.status, a.questionOrder]), answers })).digest('hex');
  return { scope, classroom: classroom!, term: term!, session: session!, config, students, rows, results, fingerprint };
}

export async function resultDashboard(actor: Actor, scope: ResultScope) {
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, scope.sessionId, scope.termId);
    return inputs(tx, actor, scope);
  });
}

export async function compileClassResults(actor: Actor, scope: ResultScope, onlySubject?: number) {
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, scope.sessionId, scope.termId);
    const data = await inputs(tx, actor, scope);
    if (!data.config) fail('Configure valid assessment components, grading scale and ranking policy before compiling.');
    if (!data.students.length || !data.rows.length) fail('No enrolled students with registered subjects to compile.');
    if (data.results.some(r => !isEditable(r.state) || r.published)) fail('Reopen reviewed, published or locked results through the lifecycle before compiling.');
    const rows = onlySubject ? data.rows.filter(r => r.subjectId === onlySubject) : data.rows;
    if (!rows.length) fail('That subject is not offered in this class.');
    const config = data.config!;
    const subjectIds = [...new Set(rows.map(r => r.subjectId))];
    for (const subjectId of subjectIds) {
      const cohort = rows.filter(r => r.subjectId === subjectId);
      const positions = rank(cohort.map(r => ({ ...r,
        admissionNumber: data.students.find(s => s.id === r.studentId)!.admissionNumber })), config.rankingPolicy);
      for (const row of cohort) {
        const grade = gradeFor(row.total, config.gradingScale);
        const values = { schoolId: actor.schoolId, studentId: row.studentId, subjectId,
          sessionId: scope.sessionId, termId: scope.termId, caTotal: String(row.caTotal), examTotal: String(row.examTotal),
          total: String(row.total), grade: row.complete ? grade.grade : '', remark: row.complete ? grade.remark : 'Incomplete',
          subjectPosition: positions.find(p => p.studentId === row.studentId)!.position ?? 0, classSize: cohort.length,
          gradingScaleId: grade.scaleId, gradingScaleVersion: grade.scaleVersion, rankingPolicy: config.rankingPolicy,
          complete: row.complete, state: 'compiled' as const, published: false, compiledAt: new Date(),
          reviewedAt: null, publishedAt: null, lockedAt: null };
        await tx.insert(schema.subjectResults).values(values).onConflictDoUpdate({
          target: [schema.subjectResults.studentId, schema.subjectResults.subjectId, schema.subjectResults.sessionId, schema.subjectResults.termId], set: values });
      }
    }
    // Remove only editable stale offerings within this cohort; closed rows were refused above.
    const stale = data.results.filter(r => (!onlySubject || r.subjectId === onlySubject)
      && !rows.some(row => row.subjectId === r.subjectId && row.studentId === r.studentId));
    if (stale.length) await tx.delete(schema.subjectResults).where(inArray(schema.subjectResults.id, stale.map(r => r.id)));
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'results.compiled', entityType: 'subject_results',
      before: { states: [...new Set(data.results.map(r => r.state))], count: data.results.length },
      after: { ...scope, state: 'compiled', count: rows.length, fingerprint: data.fingerprint, partial: Boolean(onlySubject) } });
    return { compiled: rows.length };
  });
}

export async function transitionClassResults(actor: Actor, scope: ResultScope, to: ResultState, reason = '') {
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, scope.sessionId, scope.termId);
    const data = await inputs(tx, actor, scope);
    if (actor.role !== 'principal') fail('Only the principal may sign off, publish, lock or reopen results.');
    if (!resultStateSchema.safeParse(to).success || !data.results.length) fail('No compiled results or invalid destination.');
    const states = [...new Set(data.results.map(r => r.state))];
    if (states.length !== 1 || !canTransition(states[0]!, to) || states[0] === to) fail('Results must be in one stage and follow the ordered lifecycle. Recompile drafts first.');
    const from = states[0]!;
    if (from === 'draft' && to === 'compiled') fail('Use Compile to calculate results.');
    if ((requiresReason(from, to) || to === 'draft') && reason.trim().length < 10) fail('Provide a written correction reason of at least 10 characters.');
    if (reason.length > 2000) fail('Keep the correction reason within 2000 characters.');
    if (to === 'reviewed' && from === 'compiled' || to === 'published' && from === 'reviewed' || to === 'locked') {
      if (!data.config || !data.rows.length || data.students.some(s => !data.rows.some(r => r.studentId === s.id))
        || data.rows.some(r => !r.complete || !r.stored?.complete) || data.results.length !== data.rows.length) {
        fail('Every registered subject and assessment component must be complete before sign-off, publication or locking.');
      }
      const audits = await tx.select({ after: schema.auditLog.after }).from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, 'results.compiled'), eq(schema.auditLog.schoolId, actor.schoolId)))
        .orderBy(asc(schema.auditLog.id));
      const latest = audits.map(a => a.after as Record<string, unknown> | null)
        .filter(a => a?.classId === scope.classId && a?.sessionId === scope.sessionId && a?.termId === scope.termId).at(-1);
      if (!latest || latest.partial || latest.fingerprint !== data.fingerprint) fail('Scores, offerings or academic settings changed. Reopen if necessary and recompile before proceeding.');
    }
    await tx.update(schema.subjectResults).set({ state: to, published: to === 'published' || to === 'locked',
      ...(to === 'reviewed' ? { reviewedAt: new Date() } : {}),
      ...(to === 'published' ? { publishedAt: new Date() } : {}), ...(to === 'locked' ? { lockedAt: new Date() } : {}) })
      .where(inArray(schema.subjectResults.id, data.results.map(r => r.id)));
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: `results.${to}`, entityType: 'subject_results', before: { ...scope, state: from, count: data.results.length },
      after: { ...scope, state: to, count: data.results.length }, reason: reason.trim() || null });
    return { ok: true, moved: data.results.length };
  });
}
