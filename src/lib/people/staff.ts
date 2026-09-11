/**
 * Staff lifecycle: register, edit, reset password, reactivate/stand down —
 * and the class/subject assignments that define what a teacher is responsible
 * for.
 *
 * Legacy parity (portal/school/staff.php + PortalActions + StaffService):
 * - Creating a teacher and assigning them are separate acts. A new hire with
 *   "nothing given yet" is a correct, expressible state.
 * - The staff number is GENERATED (SCHOOL_CODE/STF/001), never invented, and
 *   the login is provisioned from it with a one-time temporary password.
 * - One class teacher per class: assigning a second REPLACES the first
 *   (status 'replaced'), because mid-session reassignment is a normal event.
 * - Standing someone down is a soft archive: results, questions and
 *   invigilation history point at the row and must stay readable.
 *
 * Every entry point re-checks the caller's role at the service boundary, the
 * same defense-in-depth src/lib/platform/schools.ts applies: a route guard
 * can be forgotten when a new page is added; the service check cannot.
 *
 * Deferred from legacy, deliberately: passport photo upload for staff (the
 * app has no file storage for portal uploads yet) and HOD/department
 * assignments (the department model has no consumers in the ported flows).
 */

import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { schema, forSchool, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { hashPassword } from '@/lib/auth/password';

export class StaffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffError';
  }
}

/** Roles a staff record may hold. Platform admin is not a school staff role;
 *  student and parent identities come from their own tables, never staff. */
export const STAFF_ROLES = ['teacher', 'exam_officer', 'vice_principal', 'principal'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABEL: Record<StaffRole, string> = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  exam_officer: 'Examination Officer',
  teacher: 'Teacher',
};

/** Legacy MANAGE_STAFF / ASSIGN_STAFF: both sit with the vice principal and
 *  the principal. Teachers (class-teacher scope included) may view students
 *  but never edit staff. */
const MANAGE_STAFF_ROLES = ['principal', 'vice_principal'];

function assertManageStaff(actor: Actor): void {
  if (!MANAGE_STAFF_ROLES.includes(actor.role)) {
    throw new StaffError('You do not have permission to manage staff.');
  }
}

/** A 10-character one-time password handed over once, in person, and changed
 *  at first sign-in (users.must_change_password). The alphabet drops easily
 *  confused glyphs (i/l/o/0/1) so a dictated password survives the dictation. */
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ── Registration ─────────────────────────────────────────────────────────────

export type RegisterStaffInput = {
  firstName: string;
  lastName: string;
  title?: string;
  gender?: string;
  email?: string;
  phone?: string;
  /** Set by the action layer after savePassportPhoto; absent photo is fine. */
  photoUrl?: string;
  role: StaffRole;
};

export type RegisteredStaff = {
  staffId: number;
  staffNumber: string;
  loginId: string;
  temporaryPassword: string;
  name: string;
};

/**
 * {SCHOOL_CODE}/STF/001 — generated, so nobody invents or duplicates one.
 * Sequence follows insertion order and re-checks for collisions (numbers can
 * be taken by rows restored from a backup with higher ids).
 */
async function allocateStaffNumber(tx: Tx, schoolId: number): Promise<string> {
  const [school] = await tx.select({ code: schema.schools.code }).from(schema.schools)
    .where(eq(schema.schools.id, schoolId)).limit(1);
  const prefix = `${school?.code || 'SCH'}/STF/`;

  const [last] = await tx.select({ staffNumber: schema.staff.staffNumber }).from(schema.staff)
    .where(and(eq(schema.staff.schoolId, schoolId), sql`${schema.staff.staffNumber} LIKE ${prefix + '%'}`))
    .orderBy(desc(schema.staff.id)).limit(1);

  let sequence = 1;
  if (last) {
    const digits = /(\d+)$/.exec(last.staffNumber);
    if (digits) sequence = Number(digits[1]) + 1;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${prefix}${String(sequence).padStart(3, '0')}`;
    const [taken] = await tx.select({ id: schema.staff.id }).from(schema.staff)
      .where(and(eq(schema.staff.schoolId, schoolId), eq(schema.staff.staffNumber, candidate))).limit(1);
    if (!taken) return candidate;
    sequence += 1;
  }

  throw new StaffError('A staff number could not be allocated. Too many staff share this prefix.');
}

export async function registerStaff(actor: Actor, input: RegisterStaffInput): Promise<RegisteredStaff> {
  assertManageStaff(actor);

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = (input.email ?? '').trim().toLowerCase();
  const role = input.role;

  if (!firstName || !lastName) throw new StaffError('A staff member needs a first name and a surname.');
  if (email && !email.includes('@')) throw new StaffError('That email address is not valid.');
  if (!STAFF_ROLES.includes(role)) throw new StaffError('Choose a valid staff role.');

  return forSchool(actor.schoolId, async (tx) => {
    // A school has ONE principal. The legacy edit form's transfer rule is
    // applied at creation too, so a second principal can never be CREATED
    // either — two accounts that can approve results, with no way to tell
    // whose decision was whose.
    if (role === 'principal') {
      const [incumbent] = await tx.select({ id: schema.staff.id }).from(schema.staff)
        .where(and(
          eq(schema.staff.schoolId, actor.schoolId),
          eq(schema.staff.role, 'principal'),
          eq(schema.staff.status, 'active'),
        )).limit(1);
      if (incumbent) {
        throw new StaffError('This school already has a principal. Edit the existing principal to transfer the role.');
      }
    }

    const staffNumber = await allocateStaffNumber(tx, actor.schoolId);
    const temporaryPassword = generateTemporaryPassword();
    // The staff number is the login id: slash is not keyboard-friendly, so it
    // becomes a dot — GRE/STF/001 signs in as GRE.STF.001.
    const loginId = staffNumber.replace(/\//g, '.');
    const passwordHash = await hashPassword(temporaryPassword);

    const [user] = await tx.insert(schema.users).values({
      schoolId: actor.schoolId,
      role,
      loginId,
      passwordHash,
      mustChangePassword: true,
      status: 'active',
    }).returning({ id: schema.users.id });

    const [staffRow] = await tx.insert(schema.staff).values({
      schoolId: actor.schoolId,
      userId: user!.id,
      staffNumber,
      firstName,
      lastName,
      title: input.title?.trim() || null,
      gender: input.gender?.trim() || null,
      email: email || null,
      phone: input.phone?.trim() || null,
      photoUrl: input.photoUrl || null,
      role,
      status: 'active',
    }).returning({ id: schema.staff.id });

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.registered',
      entityType: 'staff',
      entityId: Number(staffRow!.id),
      after: {
        staffNumber,
        loginId,
        role,
        temporaryPasswordIssued: true, // the value itself is never recorded
      },
    });

    return {
      staffId: Number(staffRow!.id),
      staffNumber,
      loginId,
      temporaryPassword,
      name: `${firstName} ${lastName}`,
    };
  });
}

// ── Editing ───────────────────────────────────────────────────────────────────

export type UpdateStaffInput = {
  staffId: number;
  firstName: string;
  lastName: string;
  title?: string;
  email?: string;
  phone?: string;
  role?: StaffRole;
  confirmTransfer?: boolean;
  /** New photo URL, or undefined to keep the current one. */
  photoUrl?: string;
};

export async function updateStaff(actor: Actor, input: UpdateStaffInput): Promise<void> {
  assertManageStaff(actor);

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName) throw new StaffError('A staff member needs a first name and a surname.');
  if (input.email !== undefined && input.email.trim() && !input.email.includes('@')) {
    throw new StaffError('That email address is not valid.');
  }

  const newRole = input.role;

  await forSchool(actor.schoolId, async (tx) => {
    const [existing] = await tx.select().from(schema.staff)
      .where(and(eq(schema.staff.id, input.staffId), eq(schema.staff.schoolId, actor.schoolId))).limit(1);
    if (!existing) throw new StaffError('That staff member could not be found.');

    const updates: Partial<typeof schema.staff.$inferInsert> = { firstName, lastName };
    if (input.title !== undefined) updates.title = input.title.trim() || null;
    if (input.email !== undefined) updates.email = input.email.trim().toLowerCase() || null;
    if (input.phone !== undefined) updates.phone = input.phone.trim() || null;
    // Absent = keep the current photograph; only an explicit new upload
    // replaces it, so an edit without a file never blanks the photo.
    if (input.photoUrl !== undefined) updates.photoUrl = input.photoUrl || null;

    const roleChanges = Boolean(newRole) && newRole !== existing.role;

    if (roleChanges && newRole) {
      if (newRole === 'principal') {
        // One principal per school. The transfer is explicit, and the incumbent
        // becomes a vice principal — a silent second principal is two accounts
        // that can approve results with no way to tell whose decision was whose.
        const [incumbent] = await tx.select({ id: schema.staff.id }).from(schema.staff)
          .where(and(
            eq(schema.staff.schoolId, actor.schoolId),
            eq(schema.staff.role, 'principal'),
            eq(schema.staff.status, 'active'),
            ne(schema.staff.id, input.staffId),
          )).limit(1);

        if (incumbent && !input.confirmTransfer) {
          throw new StaffError('This school already has a principal. Tick the transfer box to move the role — the current principal becomes a vice principal.');
        }
        if (incumbent) {
          await tx.update(schema.staff).set({ role: 'vice_principal' })
            .where(eq(schema.staff.id, incumbent.id));
          const [incumbentUser] = await tx.select({ userId: schema.staff.userId }).from(schema.staff)
            .where(eq(schema.staff.id, incumbent.id)).limit(1);
          if (incumbentUser?.userId) {
            await tx.update(schema.users).set({ role: 'vice_principal' })
              .where(eq(schema.users.id, incumbentUser.userId));
          }
          await tx.insert(schema.auditLog).values({
            schoolId: actor.schoolId,
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'staff.role_transferred',
            entityType: 'staff',
            entityId: Number(incumbent.id),
            before: { role: 'principal' },
            after: { role: 'vice_principal', toStaffId: input.staffId },
          });
        }
      }

      // Never leave a school with no principal. Demoting the last one strands
      // the school: nobody could approve results or hand the role back, and
      // the change cannot be undone from inside the portal.
      if (existing.role === 'principal') {
        const others = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.staff)
          .where(and(
            eq(schema.staff.schoolId, actor.schoolId),
            eq(schema.staff.role, 'principal'),
            eq(schema.staff.status, 'active'),
            ne(schema.staff.id, input.staffId),
          ));
        if (!others[0] || others[0].count === 0) {
          throw new StaffError('This is the school\'s only principal. Give the role to someone else first — a school with no principal cannot approve or publish results.');
        }
      }

      updates.role = newRole;
      // The staff row and the login must agree, or the person keeps their old
      // capabilities and the change appears to have done nothing.
      if (existing.userId) {
        await tx.update(schema.users).set({ role: newRole }).where(eq(schema.users.id, existing.userId));
      }
    }

    await tx.update(schema.staff).set(updates).where(
      and(eq(schema.staff.id, input.staffId), eq(schema.staff.schoolId, actor.schoolId)));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.updated',
      entityType: 'staff',
      entityId: input.staffId,
      before: { firstName: existing.firstName, lastName: existing.lastName, role: existing.role },
      after: {
        firstName: updates.firstName,
        lastName: updates.lastName,
        role: updates.role,
        roleChanged: roleChanges || undefined,
      },
    });
  });
}

// ── Password reset ───────────────────────────────────────────────────────────

export type PasswordResetResult = { name: string; loginId: string; temporaryPassword: string };

export async function resetStaffPassword(actor: Actor, staffId: number): Promise<PasswordResetResult> {
  assertManageStaff(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select({
      id: schema.staff.id,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
      userId: schema.staff.userId,
    }).from(schema.staff)
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new StaffError('That staff member could not be found.');

    const [user] = row.userId
      ? await tx.select({ id: schema.users.id, loginId: schema.users.loginId })
        .from(schema.users).where(eq(schema.users.id, row.userId)).limit(1)
      : [];
    if (!user) throw new StaffError('That staff member has no login account.');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await tx.update(schema.users).set({
      passwordHash,
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
    }).where(eq(schema.users.id, user.id));

    // The current password stops working immediately — legacy wp_set_password
    // invalidated all cookies; database sessions are deleted for the same
    // effect, mid-examination included.
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.password_reset',
      entityType: 'users',
      entityId: Number(user.id),
      after: { temporaryPasswordIssued: true, sessionsRevoked: true },
    });

    return {
      name: `${row.firstName} ${row.lastName}`,
      loginId: user.loginId,
      temporaryPassword,
    };
  });
}

// ── Stand-down and reactivation ───────────────────────────────────────────────

export type StaffHolding = { assignmentId: number; label: string };

/**
 * What a staff member still holds, in words a principal can act on. Shown
 * before removal so nobody confirms consequences they cannot see.
 */
export async function staffHoldings(tx: Tx, staffId: number): Promise<StaffHolding[]> {
  const rows = await tx.select({
    assignmentId: schema.staffAssignments.id,
    assignmentType: schema.staffAssignments.assignmentType,
    className: schema.classes.displayName,
    subjectName: schema.subjects.name,
  }).from(schema.staffAssignments)
    .leftJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
    .leftJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
    .where(and(
      eq(schema.staffAssignments.staffId, staffId),
      eq(schema.staffAssignments.status, 'active'),
    ))
    .orderBy(asc(schema.subjects.name));

  return rows.map((row) => ({
    assignmentId: Number(row.assignmentId),
    label: row.assignmentType === 'class_teacher'
      ? `Class teacher: ${row.className ?? 'unassigned class'}`
      : `${row.subjectName ?? 'subject'} (${row.className ?? 'unassigned class'})`,
  }));
}

export async function standDownStaff(
  actor: Actor,
  staffId: number,
  confirmReassign: boolean,
): Promise<{ name: string; released: StaffHolding[] }> {
  assertManageStaff(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select({
      id: schema.staff.id,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
      role: schema.staff.role,
      userId: schema.staff.userId,
    }).from(schema.staff)
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new StaffError('That staff member could not be found.');

    if (row.role === 'principal') {
      throw new StaffError('This is the school\'s principal. Give the role to someone else first — a school with no principal cannot approve or publish results.');
    }

    const holdings = await staffHoldings(tx, staffId);
    if (holdings.length > 0 && !confirmReassign) {
      throw new StaffError(
        `This person still holds: ${holdings.map((h) => h.label).join('; ')}. `
        + 'Reassign those first, or tick the confirmation to stand them down anyway.');
    }

    // Never hard-delete: results, questions and invigilation records point
    // here, and a kept row keeps that history readable.
    await tx.update(schema.staff).set({ status: 'left' })
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, actor.schoolId)));
    await tx.update(schema.staffAssignments).set({ status: 'ended' })
      .where(and(eq(schema.staffAssignments.staffId, staffId), eq(schema.staffAssignments.status, 'active')));

    if (row.userId) {
      await tx.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, row.userId));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId));
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.stood_down',
      entityType: 'staff',
      entityId: staffId,
      after: { releasedAssignments: holdings.map((h) => h.label) },
    });

    return { name: `${row.firstName} ${row.lastName}`, released: holdings };
  });
}

/**
 * Reinstate someone stood down by mistake. The archive is reversible; the
 * legacy archived row had no way back from inside the portal, which is how a
 * typo at the end of term became a support ticket.
 */
export async function reactivateStaff(actor: Actor, staffId: number): Promise<string> {
  assertManageStaff(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select({
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
      status: schema.staff.status,
      role: schema.staff.role,
      userId: schema.staff.userId,
    }).from(schema.staff)
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new StaffError('That staff member could not be found.');
    if (row.status !== 'left') throw new StaffError('Only staff marked as having left can be reactivated.');

    // The principal rule still applies on the way back in.
    if (row.role === 'principal') {
      const [incumbent] = await tx.select({ id: schema.staff.id }).from(schema.staff)
        .where(and(
          eq(schema.staff.schoolId, actor.schoolId),
          eq(schema.staff.role, 'principal'),
          eq(schema.staff.status, 'active'),
        )).limit(1);
      if (incumbent) throw new StaffError('This school already has a principal. Reactivate them as a vice principal instead.');
    }

    await tx.update(schema.staff).set({ status: 'active' })
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, actor.schoolId)));

    if (row.userId) {
      await tx.update(schema.users).set({ status: 'active' })
        .where(eq(schema.users.id, row.userId));
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.reactivated',
      entityType: 'staff',
      entityId: staffId,
      after: { status: 'active' },
    });

    return `${row.firstName} ${row.lastName}`;
  });
}

// ── Assignments ──────────────────────────────────────────────────────────────

export type AssignmentRow = { staffId: number; classIds: number[]; subjectIds: number[] };
export type AssignBulkResult = { saved: number; problems: string[] };

async function validateAssignmentTarget(
  tx: Tx,
  schoolId: number,
  staffId: number,
  classId: number,
  subjectId: number | null,
): Promise<void> {
  const [staffRow] = await tx.select({ id: schema.staff.id, status: schema.staff.status }).from(schema.staff)
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.schoolId, schoolId))).limit(1);
  if (!staffRow || staffRow.status !== 'active') throw new StaffError('That staff member could not be found.');

  const [classRow] = await tx.select({ id: schema.classes.id }).from(schema.classes)
    .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, schoolId))).limit(1);
  if (!classRow) throw new StaffError('That class could not be found.');

  if (subjectId !== null) {
    const [subjectRow] = await tx.select({ id: schema.subjects.id }).from(schema.subjects)
      .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, schoolId))).limit(1);
    if (!subjectRow) throw new StaffError('That subject could not be found.');
  }
}

/**
 * Assign several teachers, each to several subjects across several classes, in
 * one save. The legacy form did one pair at a time; an Agricultural Science
 * teacher taking the subject across the whole junior school meant nine
 * separate saves. The work is the same; the tedium was the bug.
 */
export async function assignBulk(
  actor: Actor,
  type: 'class_teacher' | 'subject_teacher',
  rows: AssignmentRow[],
): Promise<AssignBulkResult> {
  assertManageStaff(actor);

  const saved: number[] = [];
  const problems: string[] = [];

  const work: Array<{ staffId: number; classId: number; subjectId: number | null }> = [];

  for (const row of rows) {
    if (!row.staffId && row.classIds.length === 0) continue; // an untouched empty row
    if (!row.staffId) { problems.push('a row had no teacher chosen'); continue; }
    if (row.classIds.length === 0) { problems.push('a row had no class chosen'); continue; }

    if (type === 'class_teacher') {
      for (const classId of row.classIds) work.push({ staffId: row.staffId, classId, subjectId: null });
      continue;
    }

    if (row.subjectIds.length === 0) { problems.push('a row had no subject chosen'); continue; }
    for (const subjectId of row.subjectIds) {
      for (const classId of row.classIds) work.push({ staffId: row.staffId, classId, subjectId });
    }
  }

  if (work.length === 0) {
    throw new StaffError(problems.length ? `Nothing was assigned: ${[...new Set(problems)].slice(0, 3).join('; ')}.` : 'Choose at least one teacher and class.');
  }

  for (const item of work) {
    await forSchool(actor.schoolId, async (tx) => {
      await validateAssignmentTarget(tx, actor.schoolId, item.staffId, item.classId, item.subjectId);

      // Exactly one class teacher per class. Two people both believing they own
      // a class is how remarks and promotion decisions get overwritten. Replace
      // rather than refuse: mid-session reassignment is a normal event, but
      // the outgoing teacher's row is retired explicitly ('replaced'), so
      // history keeps the handover.
      if (type === 'class_teacher') {
        const incumbents = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments)
          .where(and(
            eq(schema.staffAssignments.schoolId, actor.schoolId),
            eq(schema.staffAssignments.assignmentType, 'class_teacher'),
            eq(schema.staffAssignments.classId, item.classId),
            eq(schema.staffAssignments.status, 'active'),
            ne(schema.staffAssignments.staffId, item.staffId),
          ));
        for (const incumbent of incumbents) {
          await tx.update(schema.staffAssignments).set({ status: 'replaced' })
            .where(eq(schema.staffAssignments.id, incumbent.id));
          await tx.insert(schema.auditLog).values({
            schoolId: actor.schoolId,
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'staff.assignment_replaced',
            entityType: 'staff_assignments',
            entityId: Number(incumbent.id),
            before: { status: 'active' },
            after: { status: 'replaced', byStaffId: item.staffId },
          });
        }
      }

      // Reactivating an ended row is the normal case when a teacher returns to
      // a subject; the unique index would otherwise refuse a second copy of the
      // same (staff, subject, class, type) tuple.
      await tx.insert(schema.staffAssignments).values({
        schoolId: actor.schoolId,
        staffId: item.staffId,
        classId: item.classId,
        subjectId: item.subjectId,
        assignmentType: type,
        status: 'active',
      }).onConflictDoUpdate({
        target: [
          schema.staffAssignments.staffId,
          schema.staffAssignments.subjectId,
          schema.staffAssignments.classId,
          schema.staffAssignments.assignmentType,
        ],
        set: { status: 'active' },
      });

      await tx.insert(schema.auditLog).values({
        schoolId: actor.schoolId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'staff.assigned',
        entityType: 'staff_assignments',
        entityId: item.staffId,
        after: { type, classId: item.classId, subjectId: item.subjectId },
      });

      saved.push(item.staffId);
    });
  }

  return { saved: saved.length, problems: [...new Set(problems)].slice(0, 5) };
}

/** Drop a single duty (legacy "Drop a subject"): a status change, never a
 *  delete — the assignment history is what explains who taught what when. */
export async function dropAssignment(actor: Actor, assignmentId: number): Promise<void> {
  assertManageStaff(actor);

  await forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.staffAssignments)
      .where(and(eq(schema.staffAssignments.id, assignmentId), eq(schema.staffAssignments.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new StaffError('That assignment could not be found.');

    await tx.update(schema.staffAssignments).set({ status: 'ended' })
      .where(eq(schema.staffAssignments.id, assignmentId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'staff.assignment_dropped',
      entityType: 'staff_assignments',
      entityId: assignmentId,
      before: { status: row.status },
      after: { status: 'ended' },
    });
  });
}
