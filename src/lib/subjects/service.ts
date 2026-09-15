/**
 * Subject management — ported from the legacy plugin's SubjectSeederService
 * and PortalActions (save_subject / delete_subject / refresh_subjects).
 *
 * Seeding only ever fires for a school that has no active subjects at all,
 * and records a flag in the school's settings once it has run, so it is safe
 * to leave in place permanently. A refresh is the deliberate, explicit way
 * to adopt the standard offering.
 *
 * Every entry point re-checks MANAGE_SUBJECTS at the service boundary: both
 * the vice principal and the principal hold it (capabilities.php).
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { schema, forSchool, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { STANDARD_SUBJECTS } from './standard-list';

export class SubjectError extends Error {
  public readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'SubjectError';
    this.field = field;
  }
}

/** Legacy MANAGE_SUBJECTS: principal and vice principal. */
const MANAGE_SUBJECTS_ROLES = ['principal', 'vice_principal'];

function assertManageSubjects(actor: Actor): void {
  if (!MANAGE_SUBJECTS_ROLES.includes(actor.role)) {
    throw new SubjectError('You do not have permission to manage subjects.');
  }
}

type Stage = 'both' | 'junior' | 'senior';
const STAGES: readonly Stage[] = ['both', 'junior', 'senior'];

// ── Standard list seeding ───────────────────────────────────────────────────

/**
 * Existing departments, keyed by the stream names the standard list uses.
 * Where a school has not split into streams the subject is simply
 * school-wide, which is correct for it.
 */
async function departmentMap(tx: Tx, schoolId: number): Promise<Record<string, number>> {
  const rows = await tx.select({ id: schema.departments.id, name: schema.departments.name })
    .from(schema.departments).where(eq(schema.departments.schoolId, schoolId));

  const map: Record<string, number> = {};
  for (const row of rows) {
    const name = (row.name ?? '').toLowerCase();
    if (name.includes('scien')) map.science = Number(row.id);
    else if (name.includes('art') || name.includes('human')) map.arts = Number(row.id);
    else if (name.includes('commerc') || name.includes('business')) map.business = Number(row.id);
  }
  return map;
}

/**
 * Insert the standard offering into the school's subject list.
 *
 * The table has a unique key on (school, code). A retired row still holds its
 * code, so inserting the same code again would fail — revive the existing row
 * instead, which also keeps every result already attached to it.
 */
export async function seedStandardSubjects(tx: Tx, schoolId: number, force: boolean): Promise<number> {
  // Count ACTIVE subjects only. Counting every row meant a refresh could
  // never seed: retiring subjects leaves retired rows behind, and the count
  // concluded this was not a fresh school.
  const active = await tx.select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.schoolId, schoolId), eq(schema.subjects.status, 'active')));

  const [school] = await tx.select({ settings: schema.schools.settings })
    .from(schema.schools).where(eq(schema.schools.id, schoolId)).limit(1);
  const settings = (school?.settings as Record<string, unknown>) ?? {};

  // Already done for this school, and it has subjects. A refresh passes
  // $force, because the school is asking for the list again on purpose.
  if (!force && active.length > 0) {
    if (settings.subjectsSeeded === true) return 0;
    await markSeeded(tx, schoolId, settings);
    return 0;
  }
  if (!force && settings.subjectsSeeded === true) return 0;

  const departments = await departmentMap(tx, schoolId);
  let created = 0;

  for (const subject of STANDARD_SUBJECTS) {
    const departmentId = subject.stream ? departments[subject.stream] ?? null : null;

    const fields = {
      name: subject.name,
      code: subject.code,
      stage: subject.stage,
      category: (subject.core ? 'core' : 'elective') as 'core' | 'elective',
      departmentId,
      isCompulsory: Boolean(subject.core),
      status: 'active',
    };

    const [held] = await tx.select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, schoolId), eq(schema.subjects.code, subject.code)))
      .limit(1);

    if (held) {
      await tx.update(schema.subjects).set(fields)
        .where(and(eq(schema.subjects.id, held.id), eq(schema.subjects.schoolId, schoolId)));
      created++;
      continue;
    }

    await tx.insert(schema.subjects).values({ ...fields, schoolId });
    created++;
  }

  await markSeeded(tx, schoolId, settings);
  return created;
}

async function markSeeded(tx: Tx, schoolId: number, settings: Record<string, unknown>): Promise<void> {
  await tx.update(schema.schools)
    .set({ settings: { ...settings, subjectsSeeded: true } })
    .where(eq(schema.schools.id, schoolId));
}

/** One-time seeding for a school with no active subjects (plugin maybe_seed). */
export async function maybeSeedSubjects(schoolId: number): Promise<number> {
  return forSchool(schoolId, (tx) => seedStandardSubjects(tx, schoolId, false));
}

/**
 * Replace the school's subject list with the standard offering, on request.
 *
 * Seeding only ever fires for a brand new school, so a school onboarded
 * before the standard list existed keeps whatever it started with. This is
 * the deliberate way to bring it up to date, and it is destructive enough
 * that it must be an explicit act — never automatic.
 *
 * A subject with NO history (no results, scores, registrations or papers) is
 * deleted; one WITH history is retired, not deleted — removing the row would
 * make a student's past term unreadable.
 */
export async function refreshStandardSubjects(actor: Actor): Promise<{
  added: number; retired: number; removed: number;
}> {
  assertManageSubjects(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const existing = await tx.select({ id: schema.subjects.id })
      .from(schema.subjects).where(eq(schema.subjects.schoolId, actor.schoolId));

    let retired = 0;
    let removed = 0;
    for (const row of existing) {
      if (await isSubjectInUse(tx, Number(row.id))) {
        await tx.update(schema.subjects).set({ status: 'retired' })
          .where(eq(schema.subjects.id, row.id));
        retired++;
        continue;
      }
      await tx.delete(schema.subjects).where(eq(schema.subjects.id, row.id));
      removed++;
    }

    const added = await seedStandardSubjects(tx, actor.schoolId, true);

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'subjects.refreshed',
      entityType: 'subjects',
      entityId: 0,
      after: { added, retired, removed },
    });

    return { added, retired, removed };
  });
}

/** Does anything in the school's history point at this subject? */
async function isSubjectInUse(tx: Tx, subjectId: number): Promise<boolean> {
  const checks = [
    schema.subjectResults, schema.assessmentScores, schema.studentSubjects,
    schema.questionSets, schema.examPapers, schema.staffAssignments,
  ];
  for (const table of checks) {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table)
      .where(eq(table.subjectId, subjectId));
    if ((row?.n ?? 0) > 0) return true;
  }
  return false;
}

// ── Create / edit / remove ──────────────────────────────────────────────────

export type SaveSubjectInput = {
  subjectId?: number;
  name: string;
  code?: string;
  stage?: string;
  departmentId?: number;
  isCompulsory?: boolean;
};

export async function saveSubject(actor: Actor, input: SaveSubjectInput): Promise<{ name: string; code: string }> {
  assertManageSubjects(actor);

  const name = input.name.trim();
  if (name === '') throw new SubjectError('A subject needs a name.', 'name');
  if (name.length > 150) throw new SubjectError('That subject name is too long.', 'name');

  // Codes distinguish the levels, so junior Mathematics (MTH-J) and senior
  // General Mathematics (MTH) are never confused.
  let code = (input.code ?? '').trim().toUpperCase();
  if (code === '') code = name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
  if (code === '') throw new SubjectError('A subject needs a code.', 'code');
  if (code.length > 50) throw new SubjectError('That code is too long.', 'code');

  const stage = (input.stage ?? 'both') as Stage;
  if (!STAGES.includes(stage)) throw new SubjectError('Choose a valid level.', 'stage');

  const departmentId = input.departmentId && input.departmentId > 0 ? input.departmentId : null;
  const isCompulsory = Boolean(input.isCompulsory);

  return forSchool(actor.schoolId, async (tx) => {
    // The same handler creates and edits. A separate update path would drift
    // out of step with this one the first time a field was added.
    const subjectId = input.subjectId && input.subjectId > 0 ? input.subjectId : 0;

    const clash = await tx.select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(and(
        eq(schema.subjects.schoolId, actor.schoolId),
        eq(schema.subjects.code, code),
        subjectId > 0 ? ne(schema.subjects.id, subjectId) : sql`true`,
      )).limit(1);

    if (clash.length > 0) {
      throw new SubjectError(`A subject with the code ${code} already exists.`, 'code');
    }

    if (subjectId > 0) {
      const [updated] = await tx.update(schema.subjects).set({
        name, code, stage, departmentId, isCompulsory,
      }).where(and(
        eq(schema.subjects.id, subjectId),
        eq(schema.subjects.schoolId, actor.schoolId),
      )).returning({ id: schema.subjects.id, name: schema.subjects.name, code: schema.subjects.code });

      if (!updated) throw new SubjectError('That subject could not be found.');

      await tx.insert(schema.auditLog).values({
        schoolId: actor.schoolId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'subject.updated',
        entityType: 'subjects',
        entityId: subjectId,
        after: { name, code, stage, departmentId, isCompulsory },
      });

      return { name: updated.name, code: updated.code };
    }

    const [created] = await tx.insert(schema.subjects).values({
      schoolId: actor.schoolId,
      name,
      code,
      stage,
      category: 'elective',
      departmentId,
      isCompulsory,
      status: 'active',
    }).returning({ id: schema.subjects.id, name: schema.subjects.name, code: schema.subjects.code });

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'subject.created',
      entityType: 'subjects',
      entityId: Number(created!.id),
      after: { name, code, stage, departmentId, isCompulsory },
    });

    return { name: created!.name, code: created!.code };
  });
}

export async function deleteSubject(actor: Actor, subjectId: number): Promise<{
  retired: boolean; name: string; records?: number;
}> {
  assertManageSubjects(actor);
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    throw new SubjectError('That subject could not be found.');
  }

  return forSchool(actor.schoolId, async (tx) => {
    const [subject] = await tx.select({ id: schema.subjects.id, name: schema.subjects.name })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, actor.schoolId)))
      .limit(1);

    if (!subject) throw new SubjectError('That subject could not be found.');

    const [records] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.subjectResults)
      .where(eq(schema.subjectResults.subjectId, subjectId));
    const [scores] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.assessmentScores)
      .where(eq(schema.assessmentScores.subjectId, subjectId));
    const [registrations] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.studentSubjects)
      .where(eq(schema.studentSubjects.subjectId, subjectId));
    const [papers] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.questionSets)
      .where(eq(schema.questionSets.subjectId, subjectId));

    const inUse = (records?.n ?? 0) + (scores?.n ?? 0) + (registrations?.n ?? 0) + (papers?.n ?? 0);

    // Retired rather than deleted where the subject has been used: a subject
    // that appears in a student's results or on a compiled report card cannot
    // be erased without making those records unreadable.
    if (inUse > 0) {
      await tx.update(schema.subjects).set({ status: 'retired' })
        .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, actor.schoolId)));

      await tx.insert(schema.auditLog).values({
        schoolId: actor.schoolId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'subject.retired',
        entityType: 'subjects',
        entityId: subjectId,
        after: { name: subject.name, records: inUse },
      });

      return { retired: true, name: subject.name, records: inUse };
    }

    await tx.delete(schema.subjects)
      .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, actor.schoolId)));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'subject.deleted',
      entityType: 'subjects',
      entityId: subjectId,
      after: { name: subject.name },
    });

    return { retired: false, name: subject.name };
  });
}

// ── Read model ──────────────────────────────────────────────────────────────

export type SubjectRow = {
  id: number;
  name: string;
  code: string;
  stage: Stage;
  category: string;
  isCompulsory: boolean;
  departmentId: number | null;
  departmentName: string | null;
  teachers: { name: string; classes: string[] }[];
};

export type SubjectsView = {
  rows: SubjectRow[];
  departments: { id: number; name: string }[];
  standardLoaded: boolean;
  activeCount: number;
};

/**
 * The subjects screen: active subjects with who teaches what, plus the
 * standard-list card state. Without the teacher column the subject list says
 * nothing about whether a subject actually has anyone responsible for it.
 */
export async function subjectsView(
  actor: Actor,
  filters: { stage?: string; assigned?: string; departmentId?: number } = {},
): Promise<SubjectsView> {
  const stage = STAGES.includes(filters.stage as Stage) ? (filters.stage as Stage) : null;
  const assigned = filters.assigned === 'assigned' || filters.assigned === 'unassigned'
    ? filters.assigned : null;
  const departmentId = filters.departmentId && filters.departmentId > 0 ? filters.departmentId : null;

  return forSchool(actor.schoolId, async (tx) => {
    const departments = await tx.select({ id: schema.departments.id, name: schema.departments.name })
      .from(schema.departments)
      .where(eq(schema.departments.schoolId, actor.schoolId))
      .orderBy(asc(schema.departments.sortOrder), asc(schema.departments.name));

    const subjects = await tx.select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      code: schema.subjects.code,
      stage: schema.subjects.stage,
      category: schema.subjects.category,
      isCompulsory: schema.subjects.isCompulsory,
      departmentId: schema.subjects.departmentId,
      departmentName: schema.departments.name,
    })
      .from(schema.subjects)
      .leftJoin(schema.departments, eq(schema.departments.id, schema.subjects.departmentId))
      .where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .orderBy(asc(schema.subjects.stage), descCompulsory(), asc(schema.subjects.name));

    const assignments = await tx.select({
      subjectId: schema.staffAssignments.subjectId,
      classId: schema.staffAssignments.classId,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
      className: schema.classes.displayName,
    })
      .from(schema.staffAssignments)
      .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.status, 'active'),
        eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
      ))
      .orderBy(asc(schema.staff.lastName));

    // subject → teacher → classes, mirroring the plugin's teacher map.
    const teachers = new Map<number, Map<string, string[]>>();
    for (const a of assignments) {
      if (a.subjectId == null) continue;
      const sid = Number(a.subjectId);
      const name = `${a.firstName} ${a.lastName}`;
      if (!teachers.has(sid)) teachers.set(sid, new Map());
      const byName = teachers.get(sid)!;
      if (!byName.has(name)) byName.set(name, []);
      if (a.className && !byName.get(name)!.includes(a.className)) byName.get(name)!.push(a.className);
    }

    let rows: SubjectRow[] = subjects.map((s) => ({
      id: Number(s.id),
      name: s.name,
      code: s.code,
      stage: s.stage as Stage,
      category: s.category,
      isCompulsory: s.isCompulsory,
      departmentId: s.departmentId == null ? null : Number(s.departmentId),
      departmentName: s.departmentName,
      teachers: [...(teachers.get(Number(s.id))?.entries() ?? [])]
        .map(([name, classes]) => ({ name, classes })),
    }));

    if (stage === 'junior') rows = rows.filter((r) => r.stage === 'junior' || r.stage === 'both');
    if (stage === 'senior') rows = rows.filter((r) => r.stage === 'senior' || r.stage === 'both');
    if (departmentId) rows = rows.filter((r) => r.departmentId === departmentId);
    if (assigned === 'assigned') rows = rows.filter((r) => r.teachers.length > 0);
    if (assigned === 'unassigned') rows = rows.filter((r) => r.teachers.length === 0);

    const [school] = await tx.select({ settings: schema.schools.settings })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);
    const settings = (school?.settings as Record<string, unknown>) ?? {};

    // Should the "load the standard list" card be offered? The flag alone is
    // not enough — it is set even by a run that added nothing — and neither is
    // the count. What matters is whether the school HAS the standard list.
    const standardLoaded = rows.length > 0 && settings.subjectsSeeded === true;
    const activeCount = subjects.length;

    return { rows, departments, standardLoaded, activeCount };
  });
}

/** is_compulsory DESC first, as a shared order expression. */
function descCompulsory() {
  return sql`is_compulsory desc`;
}
