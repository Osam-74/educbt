/**
 * Student lifecycle: enrol, edit, place and move between classes, standing,
 * password reset, guardian linkage and subject registration.
 *
 * Legacy parity (StudentRegistrationService + PortalActions):
 * - ONE human-facing identifier, the ADMISSION NUMBER, which is also the
 *   login username. It is generated (SCH/2025/0001) unless the school types
 *   its own — a school that runs its own student IDs keeps them.
 * - The initial password is the SURNAME (normalized), and must_change_password
 *   forces a change at first sign-in. The surname is a delivery mechanism, not
 *   a credential; a class teacher can reset it in two clicks.
 * - Creating a student and placing them in a class are one transaction.
 *   A student without an enrolment is in limbo — invisible to class lists,
 *   papers and result entry alike.
 * - Moving class updates the CURRENT session's enrolment only. Past enrolments
 *   are history and must not be rewritten, or last term's results detach from
 *   the class they were actually earned in.
 * - Standing (active / suspended / withdrawn / expelled) is ONE decision, not
 *   four toggles — mutually exclusive by construction.
 * - A class teacher may add a student to a class they hold; the record and its
 *   enrolment start as pending_approval until the office approves.
 * - Guardians are linked by INVITE, never by the school choosing a password.
 *
 * Deferred from legacy, deliberately: class capacity limits (the ported
 * classes table has no capacity column — that belongs to the school-settings
 * block), bulk CSV import, and the guardian invite REDEEM flow (the school
 * side of invites lands here; redemption is its own surface).
 */

import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema, forSchool, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { hashPassword } from '@/lib/auth/password';
import { isSchoolWide } from '@/lib/queries';
import { generateTemporaryPassword } from '@/lib/people/staff';

export class StudentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentError';
  }
}

/** School-wide roles may manage any student (legacy MANAGE_STUDENTS /
 *  PLACE_STUDENTS). Teachers act only inside classes they hold. */
export function canManageStudent(actor: Actor): boolean {
  return isSchoolWide(actor.role);
}

/** Classes this actor may place students into. 'all' for school-wide roles. */
export async function placeableClassIds(actor: Actor): Promise<number[] | 'all'> {
  if (canManageStudent(actor)) return 'all';
  if (!actor.staffId) return [];
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx.select({ classId: schema.staffAssignments.classId })
      .from(schema.staffAssignments)
      .where(and(
        eq(schema.staffAssignments.staffId, actor.staffId!),
        eq(schema.staffAssignments.assignmentType, 'class_teacher'),
        eq(schema.staffAssignments.status, 'active'),
      ));
    return rows.map((r) => r.classId).filter((id): id is number => id !== null);
  });
}

async function assertCanPlace(actor: Actor, classId: number): Promise<void> {
  const allowed = await placeableClassIds(actor);
  if (allowed === 'all') return;
  if (!allowed.includes(classId)) {
    throw new StudentError('You can only place students into a class you hold.');
  }
}

async function assertCanTouchStudent(actor: Actor, tx: Tx, studentId: number): Promise<void> {
  if (canManageStudent(actor)) return;
  if (!actor.staffId) throw new StudentError('You do not have permission to manage this student.');

  const held = await tx.select({ classId: schema.staffAssignments.classId })
    .from(schema.staffAssignments)
    .where(and(
      eq(schema.staffAssignments.staffId, actor.staffId),
      eq(schema.staffAssignments.assignmentType, 'class_teacher'),
      eq(schema.staffAssignments.status, 'active'),
    ));
  const heldIds = held.map((r) => r.classId).filter((id): id is number => id !== null);
  if (heldIds.length === 0) throw new StudentError('You do not have permission to manage this student.');

  const current = await tx.select({ classId: schema.enrollments.classId })
    .from(schema.enrollments)
    .where(and(
      eq(schema.enrollments.studentId, studentId),
      eq(schema.enrollments.schoolId, actor.schoolId),
      eq(schema.enrollments.status, 'active'),
    ));
  const inHeldClass = current.some((e) => e.classId !== null && heldIds.includes(e.classId));
  if (!inHeldClass) {
    throw new StudentError('You do not have permission to manage this student.');
  }
}

/** The school's current academic session. A student is always placed into a
 *  session; without one there is nowhere to enrol them. */
export async function currentSessionId(tx: Tx, schoolId: number): Promise<number> {
  const [session] = await tx.select({ id: schema.academicSessions.id })
    .from(schema.academicSessions)
    .where(and(eq(schema.academicSessions.schoolId, schoolId), eq(schema.academicSessions.isCurrent, true)))
    .limit(1);
  return session ? Number(session.id) : 0;
}

// ── Admission numbers ─────────────────────────────────────────────────────────

/**
 * {CODE}/{YEAR}/{0001} — school code, admission year, zero-padded sequence.
 * The admission year follows the ACADEMIC year, which starts in September:
 * a student registered in October 2025 gets 2026. Generated, never typed, so
 * no two students collide and no school invents a numbering convention.
 */
export async function allocateAdmissionNumber(tx: Tx, schoolId: number): Promise<string> {
  const [school] = await tx.select({ code: schema.schools.code }).from(schema.schools)
    .where(eq(schema.schools.id, schoolId)).limit(1);
  const code = school?.code || 'SCH';

  const now = new Date();
  let year = now.getUTCFullYear();
  if (now.getUTCMonth() + 1 >= 9) year += 1;

  const prefix = `${code}/${year}/`;
  const [last] = await tx.select({ admissionNumber: schema.students.admissionNumber })
    .from(schema.students)
    .where(and(eq(schema.students.schoolId, schoolId), sql`${schema.students.admissionNumber} LIKE ${prefix + '%'}`))
    .orderBy(sql`${schema.students.id} DESC`).limit(1);

  let sequence = 1;
  if (last) {
    const digits = /(\d+)$/.exec(last.admissionNumber);
    if (digits) sequence = Number(digits[1]) + 1;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${prefix}${String(sequence).padStart(4, '0')}`;
    const [taken] = await tx.select({ id: schema.students.id }).from(schema.students)
      .where(and(eq(schema.students.schoolId, schoolId), eq(schema.students.admissionNumber, candidate))).limit(1);
    if (!taken) return candidate;
    sequence += 1;
  }

  throw new StudentError('An admission number could not be allocated. Too many students share this prefix.');
}

/**
 * Lowercased surname, stripped of anything a child cannot type — spaces,
 * apostrophes, hyphens — so "O'Brien-Smith" becomes "obriensmith". A short
 * surname would be guessable to the point of meaninglessness, so it is
 * padded. This is a TEMPORARY value; first sign-in forces a change. The
 * pad floor matches hashPassword's minimum — anything shorter would make
 * registration itself throw.
 */
export function initialPasswordFromSurname(surname: string): string {
  let password = surname.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  while (password.length < 8) password += '0';
  return password;
}

// ── Registration ─────────────────────────────────────────────────────────────

export type RegisterStudentInput = {
  firstName: string;
  lastName: string;
  gender?: string;
  dateOfBirth?: string;
  admissionNumber?: string; // blank = generate one
  photoUrl?: string; // set by the action layer after savePassportPhoto
  classId: number;
  guardian?: { fullName: string; email?: string; phone?: string; relationship?: string };
};

export type RegisteredStudent = {
  studentId: number;
  admissionNumber: string;
  loginId: string;
  initialPassword: string;
  name: string;
  pendingApproval: boolean;
};

function validateNames(firstName: string, lastName: string): void {
  if (firstName.length < 2 || lastName.length < 2) {
    throw new StudentError('A student needs a first name and a surname (at least two letters each).');
  }
}

function validateDateOfBirth(dateOfBirth?: string): void {
  if (!dateOfBirth) return;
  const parsed = new Date(dateOfBirth);
  if (Number.isNaN(parsed.getTime())) throw new StudentError('That date of birth is not a valid date.');
  if (parsed.getTime() > Date.now()) throw new StudentError('A date of birth cannot be in the future.');
}

export async function registerStudent(actor: Actor, input: RegisterStudentInput): Promise<RegisteredStudent> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  validateNames(firstName, lastName);
  validateDateOfBirth(input.dateOfBirth);

  await assertCanPlace(actor, input.classId);
  // A class teacher's addition needs the office's approval; a school-wide
  // registration is official the moment it is saved.
  const pendingApproval = !canManageStudent(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) throw new StudentError('The school has no current academic session. Set one before enrolling students.');

    const [classRow] = await tx.select({ id: schema.classes.id, status: schema.classes.status })
      .from(schema.classes)
      .where(and(eq(schema.classes.id, input.classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    if (!classRow || classRow.status !== 'active') throw new StudentError('That class could not be found.');

    // A school that runs its own student IDs types theirs and keeps it.
    // Uppercased because a student ID is a code, not a sentence.
    let admissionNumber = (input.admissionNumber ?? '').trim().toUpperCase();
    if (admissionNumber) {
      const [clash] = await tx.select({ id: schema.students.id }).from(schema.students)
        .where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.admissionNumber, admissionNumber))).limit(1);
      if (clash) throw new StudentError('That student ID is already in use by another student.');
    } else {
      admissionNumber = await allocateAdmissionNumber(tx, actor.schoolId);
    }

    const loginId = admissionNumber;
    const [loginClash] = await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.loginId, loginId)).limit(1);
    if (loginClash) throw new StudentError('That student ID is already in use as a login.');

    const initialPassword = initialPasswordFromSurname(lastName);
    const passwordHash = await hashPassword(initialPassword);

    const [user] = await tx.insert(schema.users).values({
      schoolId: actor.schoolId,
      role: 'student',
      loginId,
      passwordHash,
      mustChangePassword: true,
      status: 'active',
    }).returning({ id: schema.users.id });

    const [studentRow] = await tx.insert(schema.students).values({
      schoolId: actor.schoolId,
      userId: user!.id,
      admissionNumber,
      firstName,
      lastName,
      gender: input.gender?.trim() || null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      photoUrl: input.photoUrl || null,
      status: pendingApproval ? 'pending_approval' : 'active',
    }).returning({ id: schema.students.id });

    const studentId = Number(studentRow!.id);

    // The enrolment is what places the student in the class — creating a
    // student without one leaves them in limbo, so both happen together.
    await tx.insert(schema.enrollments).values({
      schoolId: actor.schoolId,
      studentId,
      classId: input.classId,
      sessionId,
      status: pendingApproval ? 'pending_approval' : 'active',
    });

    // Optional guardian in the same step: the office has the parent's details
    // in front of them at intake, and will not come back later.
    if (input.guardian && (input.guardian.email?.trim() || input.guardian.phone?.trim())) {
      await linkGuardianWithinTx(tx, actor, studentId, input.guardian);
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.registered',
      entityType: 'students',
      entityId: studentId,
      after: {
        admissionNumber,
        loginId,
        classId: input.classId,
        sessionId,
        status: pendingApproval ? 'pending_approval' : 'active',
        initialPasswordIsSurname: true, // the value itself is never recorded
      },
    });

    return {
      studentId,
      admissionNumber,
      loginId,
      initialPassword,
      name: `${firstName} ${lastName}`,
      pendingApproval,
    };
  });
}

// ── Editing ──────────────────────────────────────────────────────────────────

export type UpdateStudentInput = {
  studentId: number;
  firstName: string;
  lastName: string;
  gender?: string;
  dateOfBirth?: string;
  admissionNumber?: string; // changed = the login moves with it
  photoUrl?: string; // new photo; undefined = keep the current one
  classId?: number; // changed = move in the CURRENT session only
};

export async function updateStudent(actor: Actor, input: UpdateStudentInput): Promise<void> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  validateNames(firstName, lastName);
  validateDateOfBirth(input.dateOfBirth);

  await forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, input.studentId);

    const [existing] = await tx.select().from(schema.students)
      .where(and(eq(schema.students.id, input.studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
    if (!existing) throw new StudentError('That student could not be found.');

    const updates: Partial<typeof schema.students.$inferInsert> = {
      firstName,
      lastName,
      gender: input.gender?.trim() || null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
    };

    // Absent = keep the current photograph; only an explicit new upload
    // replaces it, so an edit without a file never blanks the photo.
    if (input.photoUrl !== undefined) updates.photoUrl = input.photoUrl;

    // A school that runs its own student IDs must be able to correct one after
    // the fact. The ID is also the login username, so the account has to move
    // with it or the student is locked out.
    const newAdmission = (input.admissionNumber ?? '').trim().toUpperCase();
    if (newAdmission && newAdmission !== existing.admissionNumber) {
      const [clash] = await tx.select({ id: schema.students.id }).from(schema.students)
        .where(and(
          eq(schema.students.schoolId, actor.schoolId),
          eq(schema.students.admissionNumber, newAdmission),
          ne(schema.students.id, input.studentId),
        )).limit(1);
      if (clash) throw new StudentError('That student ID is already in use by another student.');

      if (existing.userId) {
        const [loginClash] = await tx.select({ id: schema.users.id }).from(schema.users)
          .where(eq(schema.users.loginId, newAdmission)).limit(1);
        if (loginClash) throw new StudentError('That student ID is already in use as a login.');
        await tx.update(schema.users).set({ loginId: newAdmission })
          .where(eq(schema.users.id, existing.userId));
      }

      updates.admissionNumber = newAdmission;
    }

    await tx.update(schema.students).set(updates)
      .where(and(eq(schema.students.id, input.studentId), eq(schema.students.schoolId, actor.schoolId)));

    // Moving class updates the CURRENT session's enrolment only. Past
    // enrolments are history and must not be rewritten, or last term's
    // results detach from the class they were actually earned in.
    if (input.classId && input.classId > 0) {
      await moveStudentWithinTx(tx, actor, input.studentId, input.classId, /* force */ true);
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.updated',
      entityType: 'students',
      entityId: input.studentId,
      before: {
        firstName: existing.firstName,
        lastName: existing.lastName,
        admissionNumber: existing.admissionNumber,
      },
      after: {
        firstName: updates.firstName,
        lastName: updates.lastName,
        admissionNumber: updates.admissionNumber,
        movedToClassId: input.classId || undefined,
      },
    });
  });
}

// ── Class placement ───────────────────────────────────────────────────────────

/**
 * Place or move a student into a class for the current session.
 * UNIQUE (student_id, session_id) means a move is an update, not an insert —
 * a student cannot be in two classes at once, and past sessions are never
 * touched by this operation.
 */
export async function moveStudent(actor: Actor, studentId: number, classId: number): Promise<void> {
  if (canManageStudent(actor)) {
    // fall through — school-wide may move anyone
  } else {
    await assertCanPlace(actor, classId);
  }

  await forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, studentId);
    await moveStudentWithinTx(tx, actor, studentId, classId, false);
  });
}

async function moveStudentWithinTx(
  tx: Tx,
  actor: Actor,
  studentId: number,
  classId: number,
  force: boolean,
): Promise<void> {
  if (!force) {
    const [classRow] = await tx.select({ id: schema.classes.id, status: schema.classes.status })
      .from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    if (!classRow || classRow.status !== 'active') throw new StudentError('That class could not be found.');
  }

  const sessionId = await currentSessionId(tx, actor.schoolId);
  if (!sessionId) throw new StudentError('The school has no current academic session.');

  const [existing] = await tx.select({ id: schema.enrollments.id, classId: schema.enrollments.classId })
    .from(schema.enrollments)
    .where(and(
      eq(schema.enrollments.studentId, studentId),
      eq(schema.enrollments.sessionId, sessionId),
    )).limit(1);

  if (existing) {
    if (existing.classId === classId) return;
    await tx.update(schema.enrollments).set({ classId })
      .where(eq(schema.enrollments.id, existing.id));
  } else {
    await tx.insert(schema.enrollments).values({
      schoolId: actor.schoolId,
      studentId,
      classId,
      sessionId,
      status: 'active',
    });
  }

  await tx.insert(schema.auditLog).values({
    schoolId: actor.schoolId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'student.moved',
    entityType: 'students',
    entityId: studentId,
    before: existing ? { classId: existing.classId } : undefined,
    after: { classId, sessionId },
  });
}

// ── Standing ─────────────────────────────────────────────────────────────────

export const STANDING = ['active', 'suspended', 'withdrawn', 'expelled'] as const;
export type Standing = (typeof STANDING)[number];

/**
 * Set a student's standing. One action rather than four, because these are the
 * same decision with different weight and they must be mutually exclusive — a
 * student cannot be both withdrawn and suspended, and separate toggles would
 * allow it.
 *
 * Nothing is deleted. A student who leaves keeps their record, because their
 * results are part of the school's history and a transcript may be requested
 * years later.
 */
export async function setStudentStanding(actor: Actor, studentId: number, standing: Standing): Promise<void> {
  if (!canManageStudent(actor)) {
    throw new StudentError('Only the school office can change a student\'s standing.');
  }
  if (!STANDING.includes(standing)) throw new StudentError('Choose a valid standing.');

  await forSchool(actor.schoolId, async (tx) => {
    const [existing] = await tx.select().from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
    if (!existing) throw new StudentError('That student could not be found.');

    if (existing.status === standing) return;

    await tx.update(schema.students).set({ status: standing })
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId)));

    // Withdrawn/expelled students leave their classes; suspended ones stay
    // enrolled but cannot sign in (the login is disabled below). Approving or
    // reactivating flips the enrolment back.
    if (standing === 'withdrawn' || standing === 'expelled') {
      await tx.update(schema.enrollments).set({ status: 'inactive' })
        .where(and(
          eq(schema.enrollments.studentId, studentId),
          eq(schema.enrollments.schoolId, actor.schoolId),
          eq(schema.enrollments.status, 'active'),
        ));
    }

    if (existing.userId) {
      const loginStatus = standing === 'active' ? 'active' : 'disabled';
      await tx.update(schema.users).set({ status: loginStatus })
        .where(eq(schema.users.id, existing.userId));
      if (standing !== 'active') {
        await tx.delete(schema.sessions).where(eq(schema.sessions.userId, existing.userId));
      }
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.standing_changed',
      entityType: 'students',
      entityId: studentId,
      before: { status: existing.status },
      after: { status: standing },
    });
  });
}

/**
 * Approve a pending student added by a class teacher: flip the student and
 * their enrolment from pending_approval to active. The student was already
 * created with a working login — approval makes them OFFICIAL, not visible.
 */
export async function approveStudent(actor: Actor, studentId: number): Promise<void> {
  if (!canManageStudent(actor)) {
    throw new StudentError('Only the school office can approve students.');
  }

  await forSchool(actor.schoolId, async (tx) => {
    const [existing] = await tx.select().from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
    if (!existing) throw new StudentError('That student could not be found.');
    if (existing.status !== 'pending_approval') {
      throw new StudentError('Only students awaiting approval can be approved.');
    }

    await tx.update(schema.students).set({ status: 'active' })
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId)));

    await tx.update(schema.enrollments).set({ status: 'active' })
      .where(and(
        eq(schema.enrollments.studentId, studentId),
        eq(schema.enrollments.schoolId, actor.schoolId),
        eq(schema.enrollments.status, 'pending_approval'),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.approved',
      entityType: 'students',
      entityId: studentId,
      before: { status: 'pending_approval' },
      after: { status: 'active' },
    });
  });
}

// ── Password reset ────────────────────────────────────────────────────────────

export type StudentPasswordReset = { name: string; loginId: string; initialPassword: string };

/**
 * Reset a student back to their surname password and require a change. A class
 * teacher can do this for their own students — eight-year-olds forget
 * passwords weekly — and the office for anyone.
 */
export async function resetStudentPassword(actor: Actor, studentId: number): Promise<StudentPasswordReset> {
  return forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, studentId);

    const [row] = await tx.select({
      firstName: schema.students.firstName,
      lastName: schema.students.lastName,
      userId: schema.students.userId,
    }).from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new StudentError('That student could not be found.');

    const [user] = row.userId
      ? await tx.select({ id: schema.users.id, loginId: schema.users.loginId }).from(schema.users)
        .where(eq(schema.users.id, row.userId)).limit(1)
      : [];
    if (!user) throw new StudentError('That student has no login account.');

    const initialPassword = initialPasswordFromSurname(row.lastName);
    const passwordHash = await hashPassword(initialPassword);

    await tx.update(schema.users).set({
      passwordHash,
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
    }).where(eq(schema.users.id, user.id));

    // The old password stops working immediately, on every device.
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.password_reset',
      entityType: 'users',
      entityId: Number(user.id),
      after: { initialPasswordIsSurname: true, sessionsRevoked: true },
    });

    return { name: `${row.firstName} ${row.lastName}`, loginId: user.loginId, initialPassword };
  });
}

// ── Guardians ────────────────────────────────────────────────────────────────

export type GuardianLinkInput = {
  fullName: string;
  email?: string;
  phone?: string;
  relationship?: string;
  canViewResults?: boolean;
};

export type GuardianLinkResult = { guardianId: number; created: boolean; inviteToken: string };

function newInviteToken(): string {
  // Unguessable one-time token; shown to the office once, redeemable later.
  return randomBytes(24).toString('base64url');
}

/**
 * Link a guardian to a student, creating the guardian on first sight.
 * Deduplicates on email, falling back to phone — a parent with three children
 * exists as ONE record with three links, not three unrelated rows.
 * Accounts are created by INVITE, never by the school choosing a password.
 */
export async function linkGuardian(actor: Actor, studentId: number, input: GuardianLinkInput): Promise<GuardianLinkResult> {
  return forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, studentId);
    return linkGuardianWithinTx(tx, actor, studentId, input);
  });
}

async function linkGuardianWithinTx(
  tx: Tx,
  actor: Actor,
  studentId: number,
  input: GuardianLinkInput,
): Promise<GuardianLinkResult> {
  const [student] = await tx.select({ id: schema.students.id }).from(schema.students)
    .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId))).limit(1);
  if (!student) throw new StudentError('That student could not be found.');

  const email = (input.email ?? '').trim().toLowerCase();
  const phone = (input.phone ?? '').trim();
  const fullName = (input.fullName ?? '').trim();

  if (!email && !phone) throw new StudentError('A guardian needs an email address or a phone number.');
  if (email && !email.includes('@')) throw new StudentError('That guardian email address is not valid.');
  if (!fullName) throw new StudentError('A guardian needs a name.');
  if (!canManageStudent(actor)) {
    throw new StudentError('Only the school office can link guardians.');
  }

  // Deduplicate: same email (or phone when there is no email) is the same
  // person — the link is added, the guardian is not duplicated.
  const existing = email
    ? await tx.select({ id: schema.guardians.id, inviteToken: schema.guardians.inviteToken }).from(schema.guardians)
      .where(and(eq(schema.guardians.schoolId, actor.schoolId), eq(schema.guardians.email, email))).limit(1)
    : phone
      ? await tx.select({ id: schema.guardians.id, inviteToken: schema.guardians.inviteToken }).from(schema.guardians)
        .where(and(eq(schema.guardians.schoolId, actor.schoolId), eq(schema.guardians.phone, phone))).limit(1)
      : [];

  let guardianId: number;
  let created = false;
  let inviteToken: string;

  const match = existing[0];
  if (match) {
    guardianId = Number(match.id);
    // A returning guardian does not need a second invite; the existing one is
    // re-issued so the office can hand it over again.
    inviteToken = match.inviteToken || newInviteToken();
    if (!match.inviteToken) {
      await tx.update(schema.guardians).set({ inviteToken, inviteStatus: 'pending' })
        .where(eq(schema.guardians.id, guardianId));
    }
  } else {
    inviteToken = newInviteToken();
    const [row] = await tx.insert(schema.guardians).values({
      schoolId: actor.schoolId,
      fullName,
      email: email || null,
      phone: phone || null,
      inviteToken,
      inviteStatus: 'pending',
    }).returning({ id: schema.guardians.id });
    guardianId = Number(row!.id);
    created = true;
  }

  // The link is idempotent: linking the same guardian twice must not fail.
  await tx.insert(schema.guardianStudent).values({
    schoolId: actor.schoolId,
    guardianId,
    studentId,
    relationship: input.relationship?.trim() || 'parent',
    canViewResults: input.canViewResults !== false,
  }).onConflictDoUpdate({
    target: [schema.guardianStudent.guardianId, schema.guardianStudent.studentId],
    set: {
      relationship: input.relationship?.trim() || 'parent',
      canViewResults: input.canViewResults !== false,
    },
  });

  await tx.insert(schema.auditLog).values({
    schoolId: actor.schoolId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'guardian.linked',
    entityType: 'guardian_student',
    entityId: guardianId,
    after: { studentId, created, inviteIssued: true, canViewResults: input.canViewResults !== false },
  });

  return { guardianId, created, inviteToken };
}

// ── Subject registration ──────────────────────────────────────────────────────

export type SubjectRegistrationView = {
  core: Array<{ id: number; name: string; code: string }>;
  electives: Array<{ id: number; name: string; code: string }>;
  registered: Array<{ id: number; name: string; code: string; protectedByActivity: boolean }>;
  sessionId: number;
};

/**
 * What a student's subject registration looks like for the current session:
 * the compulsory subjects (registered automatically, not optional), the
 * electives the school offers, what is currently registered, and which of
 * those already have marks — those cannot be dropped mid-term.
 */
export async function subjectRegistrationView(actor: Actor, studentId: number): Promise<SubjectRegistrationView> {
  return forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, studentId);

    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) throw new StudentError('The school has no current academic session.');

    const all = await tx.select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      code: schema.subjects.code,
      isCompulsory: schema.subjects.isCompulsory,
    }).from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')));

    const registeredRows = await tx.select({
      subjectId: schema.studentSubjects.subjectId,
    }).from(schema.studentSubjects)
      .where(and(
        eq(schema.studentSubjects.studentId, studentId),
        eq(schema.studentSubjects.sessionId, sessionId),
      ));
    const registeredIds = new Set(registeredRows.map((r) => r.subjectId));

    // Anything already assessed is immovable: dropping a subject that has CA
    // or exam marks would silently erase the student's record for the term.
    const protectedRows = await tx.select({ subjectId: schema.assessmentScores.subjectId })
      .from(schema.assessmentScores)
      .where(and(
        eq(schema.assessmentScores.studentId, studentId),
        eq(schema.assessmentScores.sessionId, sessionId),
      ));
    const protectedIds = new Set(protectedRows.map((r) => Number(r.subjectId)));

    const core: SubjectRegistrationView['core'] = [];
    const electives: SubjectRegistrationView['electives'] = [];
    const registered: SubjectRegistrationView['registered'] = [];
    for (const s of all) {
      const entry = { id: Number(s.id), name: s.name, code: s.code };
      if (s.isCompulsory) core.push(entry);
      else electives.push(entry);
      if (registeredIds.has(s.id)) {
        registered.push({ ...entry, protectedByActivity: protectedIds.has(Number(s.id)) });
      }
    }

    return { core, electives, registered, sessionId };
  });
}

export type SubjectRegistrationResult = { total: number; droppedProtected: number };

/**
 * Register subjects for the current session: compulsory subjects are always
 * on, electives are the caller's choice, and anything with existing marks
 * stays registered whatever the form says.
 */
export async function setStudentSubjects(
  actor: Actor,
  studentId: number,
  electiveSubjectIds: number[],
): Promise<SubjectRegistrationResult> {
  return forSchool(actor.schoolId, async (tx) => {
    await assertCanTouchStudent(actor, tx, studentId);

    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) throw new StudentError('The school has no current academic session.');

    const [enrolment] = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments)
      .where(and(
        eq(schema.enrollments.studentId, studentId),
        eq(schema.enrollments.sessionId, sessionId),
        eq(schema.enrollments.schoolId, actor.schoolId),
      )).limit(1);
    if (!enrolment) throw new StudentError('That student has no current enrolment. Place them in a class first.');

    const all = await tx.select({
      id: schema.subjects.id,
      isCompulsory: schema.subjects.isCompulsory,
    }).from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')));
    const allowedIds = new Set(all.map((s) => Number(s.id)));

    // Only electives are caller-chosen; a compulsory subject is not optional
    // and an unknown or retired subject is never silently registered.
    const chosen = [...new Set(electiveSubjectIds.map(Number))].filter((id) => {
      const subject = all.find((s) => Number(s.id) === id);
      return subject !== undefined && allowedIds.has(id) && !subject.isCompulsory;
    });

    const protectedRows = await tx.select({ subjectId: schema.assessmentScores.subjectId })
      .from(schema.assessmentScores)
      .where(and(
        eq(schema.assessmentScores.studentId, studentId),
        eq(schema.assessmentScores.sessionId, sessionId),
      ));
    const protectedIds = new Set(protectedRows.map((r) => Number(r.subjectId)));

    const coreIds = all.filter((s) => s.isCompulsory).map((s) => Number(s.id));
    const finalIds = [...new Set([...coreIds, ...chosen, ...protectedIds])];

    await tx.delete(schema.studentSubjects)
      .where(and(
        eq(schema.studentSubjects.studentId, studentId),
        eq(schema.studentSubjects.sessionId, sessionId),
      ));
    if (finalIds.length > 0) {
      await tx.insert(schema.studentSubjects).values(
        finalIds.map((subjectId) => ({
          schoolId: actor.schoolId,
          studentId,
          subjectId,
          sessionId,
        })),
      );
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'student.subjects_registered',
      entityType: 'students',
      entityId: studentId,
      after: { sessionId, subjectIds: finalIds.sort((a, b) => a - b) },
    });

    return {
      total: finalIds.length,
      droppedProtected: [...protectedIds].filter((id) => !finalIds.includes(id)).length,
    };
  });
}
