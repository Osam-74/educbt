import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { resultConfig, canManageResults } from '@/lib/results/config';
import { ReviewGrid } from './ReviewGrid';
import './review.css';

export const dynamic = 'force-dynamic';

/**
 * Result moderation — the principal reviews and adjusts compiled results
 * before approving them. Ported from the plugin's school/review.php: every
 * student in the class with per-subject component scores in editable
 * inputs, subject totals and grand totals recalculating live, and a
 * "Save & Recompile" that writes the moderated scores back to
 * assessment_scores and recompiles the class (totals, grades, positions).
 *
 * This is the hidden School-area route the Results table's "Review &
 * Moderate" button opens — it is not in the nav, exactly like the plugin.
 */
export default async function ReviewModerationPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId: classParam } = await params;
  const classId = Number(classParam);
  const actor = await requireSchoolSession();
  if (!canManageResults(actor)) {
    return <><h1 className="page-title">Review &amp; Moderate</h1><p>You do not have access to result moderation.</p></>;
  }

  const data = await forSchool(actor.schoolId, async (tx) => {
    const [classroom] = classId
      ? await tx.select().from(schema.classes)
          .where(and(eq(schema.classes.id, classId), eq(schema.classes.status, 'active'))).limit(1)
      : await tx.select().from(schema.classes)
          .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
          .orderBy(asc(schema.classes.displayName)).limit(1);

    if (!classroom) return null;

    const [term] = await tx.select().from(schema.terms)
      .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true))).limit(1);

    const [school] = await tx.select({ settings: schema.schools.settings })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);

    const config = resultConfig((school?.settings as Record<string, unknown>) ?? {});

    if (!term) return {
      classroom, term: null, config,
      students: [] as Array<{ id: number; name: string; admissionNumber: string }>,
      subjects: [] as Array<{ id: number; name: string; code: string }>,
      scores: [] as Array<{ key: string; score: number; maxScore: number }>,
      stored: [] as Array<{ key: string; caTotal: number; examTotal: number; complete: boolean }>,
      states: [] as string[],
    };

    const students = await tx
      .select({ id: schema.students.id, admissionNumber: schema.students.admissionNumber,
        firstName: schema.students.firstName, lastName: schema.students.lastName })
      .from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(
        eq(schema.enrollments.classId, classroom.id),
        eq(schema.enrollments.status, 'active'),
        eq(schema.enrollments.sessionId, term.sessionId),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    const ids = students.map((s) => Number(s.id));

    const subjectRows = ids.length
      ? await tx
          .selectDistinct({ id: schema.subjects.id, name: schema.subjects.name, code: schema.subjects.code })
          .from(schema.studentSubjects)
          .innerJoin(schema.subjects, eq(schema.subjects.id, schema.studentSubjects.subjectId))
          .where(and(
            inArray(schema.studentSubjects.studentId, ids),
            eq(schema.studentSubjects.sessionId, term.sessionId),
            eq(schema.subjects.status, 'active'),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    const scoreRows = ids.length
      ? await tx.select().from(schema.assessmentScores).where(and(
          inArray(schema.assessmentScores.studentId, ids),
          eq(schema.assessmentScores.sessionId, term.sessionId),
          eq(schema.assessmentScores.termId, term.id),
        ))
      : [];

    const storedRows = ids.length
      ? await tx.select({
          studentId: subjectResults.studentId, subjectId: subjectResults.subjectId,
          caTotal: subjectResults.caTotal, examTotal: subjectResults.examTotal,
          complete: subjectResults.complete, state: subjectResults.state,
        }).from(subjectResults).where(and(
          eq(subjectResults.schoolId, actor.schoolId),
          eq(subjectResults.sessionId, term.sessionId),
          eq(subjectResults.termId, term.id),
          inArray(subjectResults.studentId, ids),
        ))
      : [];

    return {
      classroom, term, config,
      students: students.map((s) => ({
        id: Number(s.id), name: `${s.lastName}, ${s.firstName}`, admissionNumber: s.admissionNumber,
      })),
      subjects: subjectRows.map((s) => ({ id: Number(s.id), name: s.name, code: s.code })),
      scores: scoreRows.map((row) => ({
        key: `${Number(row.studentId)}:${Number(row.subjectId)}:${row.componentKey}`,
        score: Number(row.score), maxScore: Number(row.maxScore),
      })),
      stored: storedRows.map((row) => ({
        key: `${Number(row.studentId)}:${Number(row.subjectId)}`,
        caTotal: Number(row.caTotal), examTotal: Number(row.examTotal), complete: row.complete,
      })),
      states: storedRows.map((row) => row.state),
    };
  });

  if (!data) return <><h1 className="page-title">Review &amp; Moderate</h1><p className="error">This class is unavailable.</p></>;

  const stageSet = [...new Set(data.states)];
  const stage = stageSet.length > 1 ? 'mixed' : stageSet[0] ?? '';

  if (!data.term) {
    return <><h1 className="page-title">Review &amp; Moderate</h1>
      <section className="card"><p className="note">No current term is set.</p></section></>;
  }

  if (data.students.length === 0) {
    return <><h1 className="page-title">Review &amp; Moderate — {data.classroom.displayName}</h1>
      <section className="card"><p className="muted">No students enrolled in this class.</p></section></>;
  }
  if (data.subjects.length === 0) {
    return <><h1 className="page-title">Review &amp; Moderate — {data.classroom.displayName}</h1>
      <section className="card"><p className="muted">No subjects registered for this class.</p></section></>;
  }

  return <div className="review-page">
    <h1 className="page-title">Review &amp; Moderate — {data.classroom.displayName}</h1>
    {stage && <p className="muted">Status: <span className="result-stage">{stage}</span></p>}
    <p className="muted">
      Adjust any score below. Subject totals and student grand totals recalculate automatically.
      When you are satisfied, click <strong>Save &amp; Recompile</strong> to write the changes,
      recompute totals, grades and positions, and leave the class ready for sign-off.
    </p>

    {/* Reviewed/published/locked results are closed to moderation — the
        audited lifecycle requires reopening through the Results page first,
        exactly the guarantee the score-entry path gives. */}
    {!['', 'draft', 'compiled', 'mixed'].includes(stage) && (
      <p className="note">
        These results are {stage}. Reopen them through the results page (with a written
        correction reason) before moderating scores.
      </p>
    )}

    <ReviewGrid
      scope={{ classId: Number(data.classroom.id), sessionId: Number(data.term.sessionId), termId: Number(data.term.id) }}
      stage={stage}
      components={data.config?.assessmentComponents ?? []}
      students={data.students}
      subjects={data.subjects}
      stored={data.stored}
      scores={data.scores}
    />
  </div>;
}
