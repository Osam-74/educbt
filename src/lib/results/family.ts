/**
 * Family-facing result discovery: a student's own published terms, and a
 * guardian's linked children with theirs.
 *
 * Every function here takes the actor and resolves identity SERVER-SIDE from
 * the session — a student page never accepts a student id from the URL, and a
 * guardian's children come from the guardian_student link table, not from a
 * query string. This mirrors the legacy ward_ids()/published_for_*() design,
 * where the status and ownership filters live in the query, never in the
 * template ("one forgotten if away from showing a parent an unapproved
 * result").
 *
 * Publication visibility follows the SAME rule the report page enforces for
 * the family audience: a term is listed iff the student has results in it and
 * every one of them is published or locked (subjectResults.published AND
 * isVisibleToFamily). The legacy read a single frozen term_results.status;
 * this schema stores per-subject rows, so the aggregate is computed here and
 * the two pages must never drift apart — a term hidden on the report page
 * must not appear on this list, and vice versa.
 *
 * Legacy lists also showed a frozen average and class position from that
 * term_results summary. The new schema deliberately has no frozen term
 * summary (see docs/results-legacy-parity.md: do not fabricate an overall
 * position), so the list shows term, session, class and subject count and
 * leaves the numbers to the report sheet itself.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db';

/** Legacy result ordering: newest session first, newest term within it. */
export type FamilyTerm = {
  termId: number;
  termTitle: string;
  sessionTitle: string;
  className: string | null;
  subjects: number;
};

/**
 * The student row for a signed-in student. Resolved from users.id, not from
 * the cached session studentId — the same live check reportAudience performs,
 * so an unlinked login sees nothing even if the session cache is stale.
 */
export async function studentSelf(tx: Tx, userId: number) {
  const [student] = await tx.select({ id: schema.students.id }).from(schema.students)
    .where(and(eq(schema.students.userId, userId), eq(schema.students.status, 'active')))
    .limit(1);
  return student ?? null;
}

/**
 * Terms whose results the FAMILY may see, newest first.
 *
 * The HAVING clause is the mirror of the report page's family rule: at least
 * one result and zero results outside published/locked. subject_results rows
 * only exist per compiled subject, so a partially published class can never
 * slip through as "published" here.
 */
export async function familyPublishedTerms(tx: Tx, studentId: number): Promise<FamilyTerm[]> {
  return tx.select({
    termId: schema.terms.id,
    termTitle: schema.terms.title,
    sessionTitle: schema.academicSessions.title,
    className: schema.classes.displayName,
    subjects: sql<number>`count(*)::int`,
  }).from(schema.subjectResults)
    .innerJoin(schema.terms, eq(schema.terms.id, schema.subjectResults.termId))
    .innerJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.subjectResults.sessionId))
    // The class label comes from the student's enrolment in that term's
    // session — the same scoping the report page applies — not from "some"
    // active enrolment (legacy duplicated children with multi-session rows).
    .leftJoin(schema.enrollments, and(
      eq(schema.enrollments.studentId, schema.subjectResults.studentId),
      eq(schema.enrollments.sessionId, schema.subjectResults.sessionId),
      eq(schema.enrollments.status, 'active'),
    ))
    .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
    .where(eq(schema.subjectResults.studentId, studentId))
    .groupBy(schema.terms.id, schema.terms.position, schema.terms.title, schema.academicSessions.title, schema.classes.displayName)
    .having(sql`count(*) > 0 AND count(*) = count(*) FILTER (
      WHERE ${schema.subjectResults.published} AND ${schema.subjectResults.state} IN ('published', 'locked'))`)
    .orderBy(desc(schema.academicSessions.title), desc(schema.terms.position));
}

export type GuardianChild = {
  id: number;
  firstName: string;
  lastName: string;
  admissionNumber: string | null;
  photoUrl: string | null;
  canViewResults: boolean;
  className: string | null;
  terms: FamilyTerm[];
};

/**
 * A guardian's children: ALL linked children (legacy lists the child even when
 * can_view_results is off, so the office's restriction is explained rather than
 * looking like a missing child), each carrying its published terms — empty
 * for restricted links, which the page states with the legacy wording.
 *
 * Ordered by surname like legacy children(); terms ordered by
 * familyPublishedTerms' own ordering.
 */
export async function guardianChildren(tx: Tx, userId: number): Promise<GuardianChild[]> {
  const links = await tx.select({
    id: schema.students.id,
    firstName: schema.students.firstName,
    lastName: schema.students.lastName,
    admissionNumber: schema.students.admissionNumber,
    photoUrl: schema.students.photoUrl,
    canViewResults: schema.guardianStudent.canViewResults,
  }).from(schema.guardians)
    .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.guardianId, schema.guardians.id))
    .innerJoin(schema.students, eq(schema.students.id, schema.guardianStudent.studentId))
    .where(and(
      eq(schema.guardians.userId, userId),
      eq(schema.students.status, 'active'),
    ))
    .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

  if (!links.length) return [];

  // Latest active enrolment's class — one label per child, newest session
  // wins (a child promoted mid-year shows the new class, matching the report).
  const classes = await tx.select({
    studentId: schema.enrollments.studentId,
    className: schema.classes.displayName,
  }).from(schema.enrollments)
    .innerJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.enrollments.sessionId))
    .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
    .where(and(
      inArray(schema.enrollments.studentId, links.map(l => l.id)),
      eq(schema.enrollments.status, 'active'),
    ))
    .orderBy(desc(schema.academicSessions.title));

  const className = new Map(classes.map(c => [c.studentId, c.className]));

  return Promise.all(links.map(async link => ({
    ...link,
    className: className.get(link.id) ?? null,
    // Restricted links carry no terms: can_view_results is enforced HERE, not
    // by hiding the Download link in React.
    terms: link.canViewResults ? await familyPublishedTerms(tx, link.id) : [],
  })));
}
