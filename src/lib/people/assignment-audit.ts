/**
 * Read-only review of subject-teacher assignments that may have been widened by the old
 * "flattening" bug (a teacher given every chosen subject in every chosen class).
 *
 * It CANNOT know what was intended, so it never changes anything: it lists the teachers whose
 * assignments form a complete subjects-by-classes grid with at least two subjects and two
 * classes, since that is the shape the bug produces and a deliberate set of separate rows
 * usually is not. A person decides. Pure function, so it is tested without a database.
 */
export type AssignmentRow = { staffId: number; subjectId: number; classId: number };

export type Suspect = {
  staffId: number;
  subjectIds: number[];
  classIds: number[];
  /** How many assignments the grid holds (subjects x classes). */
  assignments: number;
};

export function findCrossProductSuspects(rows: AssignmentRow[]): Suspect[] {
  const byStaff = new Map<number, AssignmentRow[]>();
  for (const r of rows) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
  const out: Suspect[] = [];
  for (const [staffId, mine] of byStaff) {
    const subjects = [...new Set(mine.map((r) => r.subjectId))].sort((a, b) => a - b);
    const classes = [...new Set(mine.map((r) => r.classId))].sort((a, b) => a - b);
    if (subjects.length < 2 || classes.length < 2) continue;
    const have = new Set(mine.map((r) => `${r.subjectId}:${r.classId}`));
    if (have.size !== subjects.length * classes.length) continue; // not a full grid: looks deliberate
    if (!subjects.every((s) => classes.every((c) => have.has(`${s}:${c}`)))) continue;
    out.push({ staffId, subjectIds: subjects, classIds: classes, assignments: have.size });
  }
  return out.sort((a, b) => b.assignments - a.assignments || a.staffId - b.staffId);
}

export type SuspectView = Suspect & { staffName: string; subjectNames: string[]; classNames: string[] };

/** Loads the school's active subject-teacher assignments (school id from the session) and names the suspects. Reads only. */
export async function reviewAssignments(actor: { schoolId: number; role: string }): Promise<SuspectView[]> {
  if (!['principal', 'vice_principal'].includes(actor.role)) throw new Error('You do not have permission to do that.');
  const { and, eq, isNotNull } = await import('drizzle-orm');
  const { forSchool, schema } = await import('@/db');
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx.select({ staffId: schema.staffAssignments.staffId, subjectId: schema.staffAssignments.subjectId, classId: schema.staffAssignments.classId })
      .from(schema.staffAssignments).where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.assignmentType, 'subject_teacher'), eq(schema.staffAssignments.status, 'active'), isNotNull(schema.staffAssignments.subjectId), isNotNull(schema.staffAssignments.classId)));
    const suspects = findCrossProductSuspects(rows.map((r) => ({ staffId: Number(r.staffId), subjectId: Number(r.subjectId), classId: Number(r.classId) })));
    if (!suspects.length) return [];
    const [staff, subjects, classes] = await Promise.all([
      tx.select({ id: schema.staff.id, f: schema.staff.firstName, l: schema.staff.lastName }).from(schema.staff).where(eq(schema.staff.schoolId, actor.schoolId)),
      tx.select({ id: schema.subjects.id, n: schema.subjects.name }).from(schema.subjects).where(eq(schema.subjects.schoolId, actor.schoolId)),
      tx.select({ id: schema.classes.id, n: schema.classes.displayName }).from(schema.classes).where(eq(schema.classes.schoolId, actor.schoolId)),
    ]);
    const nm = (m: Array<{ id: number; n: string }>, id: number) => m.find((x) => Number(x.id) === id)?.n ?? `#${id}`;
    return suspects.map((s) => ({ ...s, staffName: (() => { const p = staff.find((x) => Number(x.id) === s.staffId); return p ? `${p.f} ${p.l ?? ''}`.trim() : `#${s.staffId}`; })(), subjectNames: s.subjectIds.map((i) => nm(subjects, i)), classNames: s.classIds.map((i) => nm(classes, i)) }));
  });
}
