/**
 * Comprehension passages: create, edit, delete.
 *
 * A passage is written ONCE (title, instructions, text) and the questions that go
 * with it point at it, in reading order. The rules that protect a school's data:
 *
 *   - Only a person permitted for the passage's subject may write or change it.
 *   - A passage that is in use cannot be edited out from under students or deleted:
 *     once any of its questions has been handed in (submitted / under review /
 *     approved / published), is in an exam paper, or has been answered, it is locked.
 *   - Deleting a passage deletes its questions, so the caller is told exactly how
 *     many before anything is removed ({@link passageDeletePreview}).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';
import { authoringActor, authoringLock } from './authoring-access';
import { isEditable } from './sets';

export type PassageInput = { subjectId: number; title: string; instructions?: string | null; body: string; classLevel?: string };

const TITLE_MAX = 191;

function clean(input: Partial<PassageInput>) {
  const out: { title?: string; instructions?: string | null; body?: string; classLevel?: string } = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (t.length < 2) throw new Error('Give the passage a title.');
    if (t.length > TITLE_MAX) throw new Error(`The title can be at most ${TITLE_MAX} characters.`);
    out.title = t;
  }
  if (input.body !== undefined) {
    const b = input.body.replace(/\r\n/g, '\n').trim();
    if (b.length < 20) throw new Error('Write or paste the passage itself (at least a sentence or two).');
    out.body = b;
  }
  if (input.instructions !== undefined) out.instructions = input.instructions?.trim() ? input.instructions.trim() : null;
  if (input.classLevel !== undefined) out.classLevel = input.classLevel.trim().slice(0, 50);
  return out;
}

/** The actor may write passages for this subject: school-wide roles always, a teacher only when assigned to it. */
async function assertSubjectAccess(tx: Tx, actor: Actor, subjectId: number) {
  await authoringActor(tx, actor);
  const [subject] = await tx.select({ id: schema.subjects.id }).from(schema.subjects)
    .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, actor.schoolId))).limit(1);
  if (!subject) throw new Error('Choose a valid subject in this school.');
  if (isSchoolWide(actor.role)) return;
  const [assignment] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments).where(and(
    eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId!),
    eq(schema.staffAssignments.subjectId, subjectId), eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
    eq(schema.staffAssignments.status, 'active'))).limit(1);
  if (!assignment) throw new Error('You are not assigned to this subject.');
}

async function loadPassage(tx: Tx, actor: Actor, passageId: number) {
  const [p] = await tx.select().from(schema.passages)
    .where(and(eq(schema.passages.id, passageId), eq(schema.passages.schoolId, actor.schoolId))).limit(1);
  if (!p) throw new Error('That passage was not found.');
  if (p.subjectId === null) throw new Error('That passage has no subject.');
  return p as typeof p & { subjectId: number };
}

export async function createPassage(actor: Actor, input: PassageInput) {
  return forSchool(actor.schoolId, async (tx) => {
    await authoringLock(tx, actor.schoolId);
    await assertSubjectAccess(tx, actor, input.subjectId);
    const c = clean(input);
    const [dup] = await tx.select({ id: schema.passages.id }).from(schema.passages).where(and(
      eq(schema.passages.schoolId, actor.schoolId), eq(schema.passages.subjectId, input.subjectId),
      eq(schema.passages.status, 'active'), sql`lower(trim(${schema.passages.title})) = lower(${c.title})`)).limit(1);
    if (dup) throw new Error('A passage with this title already exists for this subject. Choose it from the list, or give this one a different title.');
    const [row] = await tx.insert(schema.passages).values({
      schoolId: actor.schoolId, subjectId: input.subjectId, title: c.title!, body: c.body!,
      instructions: c.instructions ?? null, classLevel: c.classLevel ?? '', authorStaffId: actor.staffId ?? null,
    }).returning();
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'passage.created', entityType: 'passages', entityId: row!.id, after: { title: c.title, subjectId: input.subjectId } });
    return row!;
  });
}

/** Active passages for a subject (and optionally a class level), newest first, each with its question count. */
export async function listPassages(actor: Actor, subjectId: number, classLevel = '') {
  return forSchool(actor.schoolId, async (tx) => {
    await assertSubjectAccess(tx, actor, subjectId);
    const rows = await tx.select({
      id: schema.passages.id, title: schema.passages.title, instructions: schema.passages.instructions,
      body: schema.passages.body, classLevel: schema.passages.classLevel,
    }).from(schema.passages).where(and(
      eq(schema.passages.schoolId, actor.schoolId), eq(schema.passages.subjectId, subjectId), eq(schema.passages.status, 'active'),
      classLevel ? sql`(${schema.passages.classLevel} = '' or ${schema.passages.classLevel} = ${classLevel})` : sql`true`,
    )).orderBy(asc(schema.passages.title));
    // How many questions each passage carries: counted separately so the numbers are plainly right.
    const counts = rows.length ? await tx.select({ passageId: schema.questions.passageId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.questions).where(and(
        eq(schema.questions.schoolId, actor.schoolId), eq(schema.questions.status, 'active'),
        inArray(schema.questions.passageId, rows.map((r) => Number(r.id)))))
      .groupBy(schema.questions.passageId) : [];
    const byId = new Map(counts.map((c) => [Number(c.passageId), c.n]));
    return rows.map((r) => ({ ...r, id: Number(r.id), questions: byId.get(Number(r.id)) ?? 0 }));
  });
}

/**
 * Everything a person needs to see before deleting: how many questions would go,
 * and whether the passage is allowed to be deleted at all (and if not, why).
 */
export async function passageDeletePreview(actor: Actor, passageId: number) {
  return forSchool(actor.schoolId, (tx) => previewTx(tx, actor, passageId));
}

async function previewTx(tx: Tx, actor: Actor, passageId: number) {
  const p = await loadPassage(tx, actor, passageId);
  await assertSubjectAccess(tx, actor, p.subjectId);
  const qs = await tx.select({
    id: schema.questions.id, setId: schema.questions.questionSetId, setStatus: schema.questionSets.status, teacherId: schema.questionSets.teacherId,
  }).from(schema.questions).innerJoin(schema.questionSets, eq(schema.questionSets.id, schema.questions.questionSetId))
    .where(and(eq(schema.questions.passageId, passageId), eq(schema.questions.schoolId, actor.schoolId), eq(schema.questions.status, 'active')));
  const ids = qs.map((q) => Number(q.id));
  const inPaper = ids.length ? (await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.paperQuestions)
    .where(and(eq(schema.paperQuestions.schoolId, actor.schoolId), inArray(schema.paperQuestions.questionId, ids))))[0]!.n : 0;
  const answered = ids.length ? (await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(schema.attemptAnswers)
    .where(and(eq(schema.attemptAnswers.schoolId, actor.schoolId), inArray(schema.attemptAnswers.questionId, ids))))[0]!.n : 0;
  const lockedSets = qs.filter((q) => !isEditable(q.setStatus)).length;
  const notMine = !isSchoolWide(actor.role) && qs.some((q) => q.teacherId !== actor.staffId);

  let reason: string | null = null;
  if (lockedSets > 0) reason = 'Some of its questions have already been handed in. Ask the exam office to send them back first.';
  else if (inPaper > 0) reason = 'Some of its questions are already in an exam paper.';
  else if (answered > 0) reason = 'Students have already answered some of its questions.';
  else if (notMine) reason = 'Some of its questions belong to another teacher.';
  return { id: Number(p.id), title: p.title, questions: ids.length, allowed: reason === null, reason };
}

export async function editPassage(actor: Actor, passageId: number, patch: Partial<Omit<PassageInput, 'subjectId'>>) {
  return forSchool(actor.schoolId, async (tx) => {
    await authoringLock(tx, actor.schoolId);
    const p = await loadPassage(tx, actor, passageId);
    await assertSubjectAccess(tx, actor, p.subjectId);
    const c = clean(patch);
    // Words may be corrected freely until students could have seen them. After that the passage is part of a paper.
    const pv = await previewTx(tx, actor, passageId);
    if (!pv.allowed) throw new Error(`This passage can no longer be changed. ${pv.reason}`);
    if (c.title && c.title.toLowerCase() !== p.title.toLowerCase()) {
      const [dup] = await tx.select({ id: schema.passages.id }).from(schema.passages).where(and(
        eq(schema.passages.schoolId, actor.schoolId), eq(schema.passages.subjectId, p.subjectId), eq(schema.passages.status, 'active'),
        sql`lower(trim(${schema.passages.title})) = lower(${c.title})`, sql`${schema.passages.id} <> ${passageId}`)).limit(1);
      if (dup) throw new Error('Another passage for this subject already has that title.');
    }
    if (Object.keys(c).length === 0) return p;
    const [row] = await tx.update(schema.passages).set(c).where(and(eq(schema.passages.id, passageId), eq(schema.passages.schoolId, actor.schoolId))).returning();
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'passage.edited', entityType: 'passages', entityId: passageId, after: c });
    return row!;
  });
}

/** Delete a passage AND the questions written on it. Refused (nothing removed) unless {@link passageDeletePreview} allows it. */
export async function deletePassageWithQuestions(actor: Actor, passageId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    await authoringLock(tx, actor.schoolId);
    const pv = await previewTx(tx, actor, passageId);
    if (!pv.allowed) throw new Error(`This passage cannot be deleted. ${pv.reason}`);
    const qs = await tx.select({ id: schema.questions.id }).from(schema.questions)
      .where(and(eq(schema.questions.passageId, passageId), eq(schema.questions.schoolId, actor.schoolId)));
    const ids = qs.map((q) => Number(q.id));
    if (ids.length) await tx.delete(schema.questions).where(and(inArray(schema.questions.id, ids), eq(schema.questions.schoolId, actor.schoolId)));
    await tx.delete(schema.passages).where(and(eq(schema.passages.id, passageId), eq(schema.passages.schoolId, actor.schoolId)));
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'passage.deleted', entityType: 'passages', entityId: passageId, before: { title: pv.title, questions: ids.length } });
    return { deletedQuestions: ids.length };
  });
}


/**
 * Passages written inside an imported file. Each one is created ONCE; if the school already has a passage for
 * this subject with the same title, that one is used, so importing the same file twice never doubles a passage.
 * Returns the id for every ref (lower-cased), and the refs that could not be made, with the reason.
 */
export async function ensurePassagesForImport(
  actor: Actor, subjectId: number,
  defs: Array<{ ref: string; title: string; instructions: string; body: string }>,
) {
  const ids = new Map<string, number>();
  const failed = new Map<string, string>();
  for (const d of defs) {
    const key = d.ref.toLowerCase();
    try {
      const found = (await listPassages(actor, subjectId)).find((p) => p.title.trim().toLowerCase() === d.title.trim().toLowerCase());
      if (found) { ids.set(key, Number(found.id)); continue; }
      const made = await createPassage(actor, { subjectId, title: d.title, instructions: d.instructions, body: d.body });
      ids.set(key, Number(made.id));
    } catch (e) {
      failed.set(key, e instanceof Error ? e.message : 'The passage could not be saved.');
    }
  }
  return { ids, failed };
}
