import { and, eq, asc, inArray } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { isVisibleToFamily } from '@/domain/academic';
import type { Actor } from '@/lib/session';
import { reportAudience } from '@/lib/results/report-access';
import { reportExtras } from '@/lib/settings/remarks';

/**
 * Everything one student's terminal report sheet needs, loaded inside the caller's school-scoped transaction.
 * Returns null when the viewer may not see this sheet (wrong audience, or results not yet visible to them), so a
 * caller can answer "not found" without revealing why. Shared by the single report and the whole-class print, so the
 * two can never disagree about who may see what or what a sheet says.
 *
 * `termId` 0 means the school's current term.
 */
export async function loadReportSheet(tx: Tx, actor: Actor, studentId: number, termId: number) {
  const query = { term: termId ? String(termId) : undefined };
    const [student] = await tx
      .select({
        id: schema.students.id,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        admissionNumber: schema.students.admissionNumber,
        photoUrl: schema.students.photoUrl,
      })
      .from(schema.students)
      .where(and(
        eq(schema.students.id, studentId),
        eq(schema.students.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!student) return null;

    const [school] = await tx
      .select({
        name: schema.schools.name,
        address: schema.schools.address,
        phone: schema.schools.phone,
        email: schema.schools.email,
        website: schema.schools.website,
        logoUrl: schema.schools.logoUrl,
        principalName: schema.schools.principalName,
      })
      .from(schema.schools)
      .where(eq(schema.schools.id, actor.schoolId))
      .limit(1);

    // Resolve the term FIRST: a chosen term id, else the school's current
    // term. Everything below hangs off term.sessionId, so one resolution
    // beats repeating the choice.
    const wantedTermId = Number(query.term ?? 0);
    const [term] = await tx
      .select()
      .from(schema.terms)
      .where(and(
        eq(schema.terms.schoolId, actor.schoolId),
        wantedTermId ? eq(schema.terms.id, wantedTermId) : eq(schema.terms.isCurrent, true),
      ))
      .limit(1);

    const [enrolment] = term
      ? await tx
          .select({
            classId: schema.enrollments.classId,
            className: schema.classes.displayName,
            sessionId: schema.academicSessions.id,
            sessionTitle: schema.academicSessions.title,
          })
          .from(schema.enrollments)
          .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
          .leftJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.enrollments.sessionId))
          .where(and(
            eq(schema.enrollments.studentId, studentId),
            eq(schema.enrollments.sessionId, Number(term.sessionId)),
            eq(schema.enrollments.status, 'active'),
          ))
          .limit(1)
      : [];

    const results = term
      ? await tx
          .select({
            subjectId: subjectResults.subjectId,
            subjectName: schema.subjects.name,
            caTotal: subjectResults.caTotal,
            examTotal: subjectResults.examTotal,
            total: subjectResults.total,
            grade: subjectResults.grade,
            remark: subjectResults.remark,
            position: subjectResults.subjectPosition,
            classSize: subjectResults.classSize,
            complete: subjectResults.complete,
            state: subjectResults.state,
            published: subjectResults.published,
            scaleId: subjectResults.gradingScaleId,
            scaleVersion: subjectResults.gradingScaleVersion,
            rankingPolicy: subjectResults.rankingPolicy,
          })
          .from(subjectResults)
          .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
          .where(and(
            eq(subjectResults.studentId, studentId),
            eq(subjectResults.termId, Number(term.id)),
            eq(subjectResults.sessionId, Number(term.sessionId)),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    const audience = await reportAudience(tx, actor, studentId, Number(term?.sessionId ?? 0));
    if (!audience) return null;
    if (audience !== 'staff' && (!results.length || results.some(r => audience === 'family'
      ? !isVisibleToFamily(r.state) || !r.published
      : !['reviewed', 'published', 'locked'].includes(r.state)))) return null;

    // Subject registration is AUTHORITATIVE for what a student sits. A
    // registered subject with no compiled scores still belongs on the sheet —
    // stated with em-dashes, never silently dropped (legacy behaviour).
    const registered = term
      ? await tx
          .select({
            subjectId: schema.studentSubjects.subjectId,
            subjectName: schema.subjects.name,
          })
          .from(schema.studentSubjects)
          .innerJoin(schema.subjects, eq(schema.subjects.id, schema.studentSubjects.subjectId))
          .where(and(
            eq(schema.studentSubjects.studentId, studentId),
            eq(schema.studentSubjects.sessionId, Number(term.sessionId)),
            eq(schema.subjects.status, 'active'),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    // ── Class cohort: "No. in Class", per-subject Class Avg / Highest, and
    // Position in Class are all derived from the SAME stored results the
    // lifecycle compiled — read-only aggregation, no values invented. The
    // legacy stored these in a term_results summary at compile time; until
    // that table exists, deriving them from subject_results keeps the sheet
    // honest (and consistent with how subject positions were stored).
    const cohort = enrolment?.classId && term
      ? await tx
          .select({ studentId: schema.enrollments.studentId, admissionNumber: schema.students.admissionNumber })
          .from(schema.enrollments)
          .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
          .where(and(
            eq(schema.enrollments.classId, enrolment.classId),
            eq(schema.enrollments.sessionId, Number(term.sessionId)),
            eq(schema.enrollments.status, 'active'),
            eq(schema.students.status, 'active'),
          ))
      : [];

    const cohortIds = cohort.map((c) => c.studentId);
    const cohortRows = cohortIds.length && term
      ? await tx
          .select({
            studentId: subjectResults.studentId,
            subjectId: subjectResults.subjectId,
            total: subjectResults.total,
            examTotal: subjectResults.examTotal,
            complete: subjectResults.complete,
          })
          .from(subjectResults)
          .where(and(
            inArray(subjectResults.studentId, cohortIds),
            eq(subjectResults.sessionId, Number(term.sessionId)),
            eq(subjectResults.termId, Number(term.id)),
          ))
      : [];

    const cohortRegistrations = cohortIds.length && term ? await tx.select({ studentId: schema.studentSubjects.studentId, subjectId: schema.studentSubjects.subjectId })
      .from(schema.studentSubjects).where(and(inArray(schema.studentSubjects.studentId, cohortIds), eq(schema.studentSubjects.sessionId, Number(term.sessionId)))) : [];

    // The class teacher whose name belongs on the sheet — the staff member
    // actually holding this class, not "any teacher".
    const [classTeacher] = enrolment?.classId
      ? await tx
          .select({ id: schema.staff.id, firstName: schema.staff.firstName, lastName: schema.staff.lastName })
          .from(schema.staffAssignments)
          .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
          .where(and(
            eq(schema.staffAssignments.classId, enrolment.classId),
            eq(schema.staffAssignments.assignmentType, 'class_teacher'),
            eq(schema.staffAssignments.status, 'active'),
            eq(schema.staff.status, 'active'),
          ))
          .limit(1)
      : [];

    const extras = term && enrolment?.classId ? await reportExtras(tx, actor.schoolId, studentId, Number(term.sessionId), Number(term.id), enrolment.classId) : null;
    const scaleSnapshots = await tx.select({ snapshot: schema.gradingScaleVersions.snapshot }).from(schema.gradingScaleVersions);
    return { student, school, enrolment, term, results, registered, cohort, cohortRows, cohortRegistrations, extras, scaleSnapshots,
      classTeacher: classTeacher ?? null };
}

export type ReportSheetData = NonNullable<Awaited<ReturnType<typeof loadReportSheet>>>;
