import { and, asc, eq, sql, inArray } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { resultConfig } from '@/lib/results/config';
import { profileSchema, sessionSchema, termSchema, periodSchema, parseAcademic, componentStructure, signatureSchema, rangeSchema, examDefaultsSchema } from './validation';

export class SettingsError extends Error {}
export const fail = (message: string): never => { throw new SettingsError(message); };
export async function settingsAccess(tx: Tx, actor: Actor, write = false) {
  if (!['principal', 'vice_principal', 'exam_officer', 'teacher'].includes(actor.role) || write && actor.role !== 'principal') fail('Only the Principal can change school configuration.');
  const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, actor.userId),
    eq(schema.users.schoolId, actor.schoolId), eq(schema.users.role, actor.role as 'principal'), eq(schema.users.status, 'active')));
  const [school] = await tx.select().from(schema.schools).where(and(eq(schema.schools.id, actor.schoolId), eq(schema.schools.status, 'active')));
  if (!user || !school) fail('This school account is unavailable.');
  return school!;
}
export async function configLock(tx: Tx, schoolId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`educbt-config:${schoolId}`}, 0))`);
}
export async function audit(tx: Tx, actor: Actor, action: string, before: unknown, after: unknown) {
  await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
    action: 'settings.' + action, entityType: 'school_settings', entityId: actor.schoolId, before, after });
}
export async function ownStaff(tx: Tx, actor: Actor, role: string) {
  const [staff] = await tx.select().from(schema.staff).where(and(eq(schema.staff.userId, actor.userId),
    eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')));
  if (!staff || staff.id !== actor.staffId) fail('An active linked staff record is required.');
  if (role === 'principal' && actor.role === 'principal') return staff!;
  if (role === 'exam_officer' && ['exam_officer', 'vice_principal', 'principal'].includes(actor.role)) return staff!;
  if (role === 'class_teacher') {
    const [assignment] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments).where(and(
      eq(schema.staffAssignments.staffId, staff!.id), eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
    if (assignment) return staff!;
  }
  return fail('This signature or remark role is not assigned to you.');
}
export async function settingsView(actor: Actor) {
  return forSchool(actor.schoolId, async tx => {
    const school = await settingsAccess(tx, actor);
    const roles: string[] = [];
    for (const role of ['principal', 'class_teacher', 'exam_officer']) {
      try { await ownStaff(tx, actor, role); roles.push(role); } catch (error) { if (!(error instanceof SettingsError)) throw error; }
    }
    const assigned = actor.staffId ? await tx.select({ classId: schema.staffAssignments.classId }).from(schema.staffAssignments).where(and(
      eq(schema.staffAssignments.staffId, actor.staffId), eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active'))) : [];
    const classIds = assigned.flatMap(a => a.classId ? [a.classId] : []);
    const students = actor.role === 'principal' || classIds.length ? await tx.select({ id: schema.students.id, firstName: schema.students.firstName,
      lastName: schema.students.lastName, admissionNumber: schema.students.admissionNumber, sessionId: schema.enrollments.sessionId })
      .from(schema.enrollments).innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId)).where(and(
        eq(schema.enrollments.status, 'active'), eq(schema.students.status, 'active'),
        actor.role === 'principal' ? undefined : inArray(schema.enrollments.classId, classIds))) : [];
    return { school, roles, students, sessions: await tx.select().from(schema.academicSessions).orderBy(asc(schema.academicSessions.title)),
      terms: await tx.select().from(schema.terms).orderBy(asc(schema.terms.position)),
      signatures: actor.staffId ? await tx.select().from(schema.staffSignatures).where(eq(schema.staffSignatures.staffId, actor.staffId)) : [],
      ranges: actor.staffId ? await tx.select().from(schema.staffRemarkRanges).where(eq(schema.staffRemarkRanges.staffId, actor.staffId)) : [],
      assessmentInUse: Boolean((await tx.select({ id: schema.assessmentScores.id }).from(schema.assessmentScores).limit(1)).length ||
        (await tx.select({ id: schema.subjectResults.id }).from(schema.subjectResults).limit(1)).length) };
  });
}
export async function saveProfile(actor: Actor, input: unknown, logo?: string | null) {
  const value = profileSchema.parse(input);
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId);
    const school = await settingsAccess(tx, actor, true);
    const before = { ...Object.fromEntries(Object.keys(value).map(k => [k, school[k as keyof typeof school]])), logoUrl: school.logoUrl };
    // logo is only supplied by the server upload normalizer, never a URL form field.
    if (logo !== undefined && logo !== null && (!logo.startsWith('data:image/png;base64,') || logo.length > 400000)) fail('Invalid normalized crest.');
    const change = { ...value, ...(logo !== undefined ? { logoUrl: logo } : {}) };
    await tx.update(schema.schools).set({ ...change, updatedAt: new Date() }).where(eq(schema.schools.id, actor.schoolId));
    await audit(tx, actor, 'profile', before, { ...value, logoUrl: logo === undefined ? school.logoUrl : logo });
  });
}
export async function saveAcademic(actor: Actor, input: unknown) {
  const next = parseAcademic(input);
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId);
    const school = await settingsAccess(tx, actor, true);
    const old = resultConfig(school.settings);
    const used = (await tx.select({ id: schema.assessmentScores.id }).from(schema.assessmentScores).limit(1)).length ||
      (await tx.select({ id: schema.subjectResults.id }).from(schema.subjectResults).limit(1)).length;
    if (used && (!old || componentStructure(old.assessmentComponents) !== componentStructure(next.assessmentComponents))) fail('Assessment weights, keys and exam designation are in use. A migration is required to change them.');
    if (old) await tx.insert(schema.gradingScaleVersions).values({ schoolId: actor.schoolId, scaleId: old.gradingScale.id,
      version: old.gradingScale.version, snapshot: old.gradingScale }).onConflictDoNothing();
    const changed = !old || JSON.stringify({ name: old.gradingScale.name, bands: old.gradingScale.bands }) !== JSON.stringify({ name: next.gradingScale.name, bands: next.gradingScale.bands });
    // The client cannot select or reuse a historical version number.
    if (changed) {
      const scaleId = 'school-' + actor.schoolId;
      const versions = await tx.select({ version: schema.gradingScaleVersions.version }).from(schema.gradingScaleVersions).where(eq(schema.gradingScaleVersions.scaleId, scaleId));
      next.gradingScale = { ...next.gradingScale, id: scaleId, version: Math.max(0, ...versions.map(v => v.version)) + 1 };
    } else next.gradingScale = old!.gradingScale;
    await tx.insert(schema.gradingScaleVersions).values({ schoolId: actor.schoolId, scaleId: next.gradingScale.id,
      version: next.gradingScale.version, snapshot: next.gradingScale }).onConflictDoNothing();
    await tx.update(schema.schools).set({ settings: { ...school.settings, ...next }, updatedAt: new Date() }).where(eq(schema.schools.id, actor.schoolId));
    await audit(tx, actor, 'academic', old, next);
  });
}
async function setPeriod(tx: Tx, actor: Actor, sessionId: number, termId: number) {
  const [term] = await tx.select().from(schema.terms).where(and(eq(schema.terms.id, termId), eq(schema.terms.sessionId, sessionId)));
  const [session] = await tx.select().from(schema.academicSessions).where(eq(schema.academicSessions.id, sessionId));
  if (!term || !session) fail('Choose a term belonging to this school and session.');
  const before = { sessions: await tx.select().from(schema.academicSessions).where(eq(schema.academicSessions.isCurrent, true)),
    terms: await tx.select().from(schema.terms).where(eq(schema.terms.isCurrent, true)) };
  await tx.update(schema.terms).set({ isCurrent: false }).where(eq(schema.terms.schoolId, actor.schoolId));
  await tx.update(schema.academicSessions).set({ isCurrent: false }).where(eq(schema.academicSessions.schoolId, actor.schoolId));
  await tx.update(schema.academicSessions).set({ isCurrent: true }).where(eq(schema.academicSessions.id, sessionId));
  await tx.update(schema.terms).set({ isCurrent: true }).where(eq(schema.terms.id, termId));
  await audit(tx, actor, 'current_period', before, { sessionId, termId });
}
export async function selectPeriod(actor: Actor, input: unknown) {
  const value = periodSchema.parse(input);
  return forSchool(actor.schoolId, async tx => { await configLock(tx, actor.schoolId); await settingsAccess(tx, actor, true); await setPeriod(tx, actor, value.sessionId, value.termId); });
}
export async function createSession(actor: Actor, input: unknown) {
  const value = sessionSchema.parse(input);
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId); await settingsAccess(tx, actor, true);
    if ((await tx.select({ id: schema.academicSessions.id }).from(schema.academicSessions).where(eq(schema.academicSessions.title, value.title))).length) fail('That session already exists.');
    const [session] = await tx.insert(schema.academicSessions).values({ schoolId: actor.schoolId, title: value.title,
      startsOn: value.startsOn ? new Date(value.startsOn) : null, endsOn: value.endsOn ? new Date(value.endsOn) : null }).returning();
    const terms = await tx.insert(schema.terms).values(['First Term', 'Second Term', 'Third Term'].map((title, i) => ({
      schoolId: actor.schoolId, sessionId: session!.id, title, position: i + 1 }))).returning();
    await audit(tx, actor, 'session_created', null, { session, terms });
    if (value.makeCurrent) await setPeriod(tx, actor, session!.id, terms[0]!.id);
    return session!;
  });
}
export async function saveTerm(actor: Actor, input: unknown) {
  const value = termSchema.parse(input);
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId); await settingsAccess(tx, actor, true);
    const [session] = await tx.select().from(schema.academicSessions).where(eq(schema.academicSessions.id, value.sessionId));
    if (!session) fail('Session unavailable.');
    if (value.startsOn && session!.startsOn && new Date(value.startsOn) < session!.startsOn ||
      value.endsOn && session!.endsOn && new Date(value.endsOn) > session!.endsOn) fail('Term dates must fall within the session dates.');
    const existing = await tx.select().from(schema.terms).where(eq(schema.terms.sessionId, value.sessionId));
    const old = existing.find(t => t.id === value.termId);
    if (value.termId && !old) fail('Term unavailable in this session.');
    if (existing.some(t => t.position === value.position && t.id !== value.termId)) fail('That term position is already used.');
    if (old && (old.title !== value.title || old.position !== value.position) &&
      (await tx.select({ id: schema.subjectResults.id }).from(schema.subjectResults).where(eq(schema.subjectResults.termId, old.id)).limit(1)).length) fail('A term used by results cannot be renamed or reordered.');
    const change = { title: value.title, position: value.position, startsOn: value.startsOn ? new Date(value.startsOn) : null, endsOn: value.endsOn ? new Date(value.endsOn) : null };
    const [after] = old ? await tx.update(schema.terms).set(change).where(eq(schema.terms.id, old.id)).returning() :
      await tx.insert(schema.terms).values({ ...change, schoolId: actor.schoolId, sessionId: value.sessionId }).returning();
    await audit(tx, actor, 'term', old ?? null, after);
  });
}
export async function saveSignature(actor: Actor, input: unknown, image?: string) {
  const value = signatureSchema.parse(input);
  if (value.type === 'upload' && (!image?.startsWith('data:image/png;base64,') || image.length > 400000)) fail('Choose a PNG or JPEG signature image.');
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId); await settingsAccess(tx, actor);
    const staff = await ownStaff(tx, actor, value.role);
    const [before] = await tx.select().from(schema.staffSignatures).where(and(eq(schema.staffSignatures.staffId, staff.id), eq(schema.staffSignatures.role, value.role)));
    const change = { schoolId: actor.schoolId, staffId: staff.id, role: value.role, name: value.name,
      type: value.type, data: value.type === 'text' ? value.text : image!, updatedAt: new Date() };
    await tx.insert(schema.staffSignatures).values(change).onConflictDoUpdate({ target: [schema.staffSignatures.schoolId, schema.staffSignatures.staffId, schema.staffSignatures.role], set: change });
    await audit(tx, actor, 'signature', before ?? null, change);
  });
}
export async function saveRanges(actor: Actor, role: string, input: unknown) {
  const ranges = rangeSchema.parse(input);
  if (!['principal', 'class_teacher'].includes(role)) fail('Choose a report remark role.');
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId); await settingsAccess(tx, actor);
    const staff = await ownStaff(tx, actor, role);
    const [before] = await tx.select().from(schema.staffRemarkRanges).where(and(eq(schema.staffRemarkRanges.staffId, staff.id), eq(schema.staffRemarkRanges.role, role)));
    const change = { schoolId: actor.schoolId, staffId: staff.id, role, ranges, updatedAt: new Date() };
    await tx.insert(schema.staffRemarkRanges).values(change).onConflictDoUpdate({ target: [schema.staffRemarkRanges.schoolId, schema.staffRemarkRanges.staffId, schema.staffRemarkRanges.role], set: change });
    await audit(tx, actor, 'remark_ranges', before ?? null, change);
  });
}
export async function saveExamDefaults(actor: Actor, input: unknown) {
  const value = examDefaultsSchema.parse(input);
  return forSchool(actor.schoolId, async tx => {
    await configLock(tx, actor.schoolId); const school = await settingsAccess(tx, actor, true);
    await tx.update(schema.schools).set({ settings: { ...school.settings, examDefaults: value }, updatedAt: new Date() }).where(eq(schema.schools.id, actor.schoolId));
    await audit(tx, actor, 'exam_defaults', school.settings.examDefaults ?? null, value);
  });
}
