/**
 * Identity and people.
 *
 * The login model is school-controlled, not consumer self-service:
 *
 *   students  sign in with an admission number
 *   staff     sign in with a staff number or email
 *   parents   sign in with an email
 *
 * The identifier is unique WITHIN A SCHOOL, not globally, so two schools can
 * both have a student numbered 2025010203. This is the requirement that rules
 * out consumer identity providers built around a globally unique email.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, timestamp,
  uniqueIndex, index, pgEnum, jsonb, inet,
} from 'drizzle-orm/pg-core';
import { schools, classes, classLevels, departments, subjects, academicSessions } from './core';
import { studentStatus, staffStatus, enrollmentStatus } from './core';

export const userRole = pgEnum('user_role', [
  'platform_admin',
  'principal',
  'vice_principal',
  'exam_officer',
  'teacher',
  'student',
  'parent',
]);

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'disabled']);

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),

  // Null only for platform_admin, who belongs to no school.
  schoolId: bigint('school_id', { mode: 'number' })
    .references(() => schools.id, { onDelete: 'cascade' }),

  role: userRole('role').notNull(),

  // Admission number, staff number, or email — whichever the role uses.
  loginId: varchar('login_id', { length: 191 }).notNull(),

  // Argon2id. Never bcrypt for new hashes; never plain SHA.
  passwordHash: text('password_hash').notNull(),

  // Enforced in middleware, not by a redirect the user can navigate around.
  mustChangePassword: boolean('must_change_password').default(true).notNull(),

  // TOTP, required for roles that can publish results or approve papers.
  // A shared staffroom password should not be enough to alter a result set.
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),

  status: userStatus('status').default('active').notNull(),

  failedAttempts: bigint('failed_attempts', { mode: 'number' }).default(0).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Scoped, not global. This is the whole auth design in one constraint.
  schoolLoginUq: uniqueIndex('users_school_login_uq').on(t.schoolId, t.loginId),
  schoolIdx: index('users_school_idx').on(t.schoolId),
}));

/**
 * Database-backed sessions, not stateless JWTs.
 *
 * A suspended student must lose access immediately. With a JWT they keep it
 * until the token expires, which during an examination is exactly wrong.
 */
export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 191 }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('sessions_user_idx').on(t.userId),
  expiryIdx: index('sessions_expiry_idx').on(t.expiresAt),
}));

// ── Staff ────────────────────────────────────────────────────────────────────

export const staff = pgTable('staff', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' })
    .references(() => users.id, { onDelete: 'set null' }),

  staffNumber: varchar('staff_number', { length: 50 }).notNull(),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 191 }),
  phone: varchar('phone', { length: 50 }),
  photoUrl: text('photo_url'),
  role: userRole('role').notNull(),
  status: staffStatus('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolNumberUq: uniqueIndex('staff_school_number_uq').on(t.schoolId, t.staffNumber),
  schoolIdx: index('staff_school_idx').on(t.schoolId),
}));

/**
 * What a teacher is responsible for. Authorisation is scoped through this:
 * a teacher may only touch the subjects and classes listed here.
 */
export const staffAssignments = pgTable('staff_assignments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  staffId: bigint('staff_id', { mode: 'number' }).notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  subjectId: bigint('subject_id', { mode: 'number' })
    .references(() => subjects.id, { onDelete: 'cascade' }),
  classId: bigint('class_id', { mode: 'number' })
    .references(() => classes.id, { onDelete: 'cascade' }),
  assignmentType: varchar('assignment_type', { length: 30 })
    .default('subject_teacher').notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
}, (t) => ({
  uq: uniqueIndex('staff_assignment_uq')
    .on(t.staffId, t.subjectId, t.classId, t.assignmentType),
  schoolIdx: index('staff_assignments_school_idx').on(t.schoolId),
}));

// ── Students ─────────────────────────────────────────────────────────────────

export const students = pgTable('students', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' })
    .references(() => users.id, { onDelete: 'set null' }),

  admissionNumber: varchar('admission_number', { length: 50 }).notNull(),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  middleName: varchar('middle_name', { length: 100 }),
  gender: varchar('gender', { length: 20 }),
  dateOfBirth: timestamp('date_of_birth', { withTimezone: true }),
  photoUrl: text('photo_url'),
  address: text('address'),

  parentName: varchar('parent_name', { length: 191 }),
  parentPhone: varchar('parent_phone', { length: 50 }),
  parentEmail: varchar('parent_email', { length: 191 }),

  status: studentStatus('status').default('active').notNull(),

  // When the standing last changed. An expulsion carries a reconsideration
  // window, which cannot be worked out without a date.
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),

  admittedAt: timestamp('admitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolAdmissionUq: uniqueIndex('students_school_admission_uq')
    .on(t.schoolId, t.admissionNumber),
  schoolIdx: index('students_school_idx').on(t.schoolId),
  statusIdx: index('students_status_idx').on(t.schoolId, t.status),
}));

export const enrollments = pgTable('enrollments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  classId: bigint('class_id', { mode: 'number' }).notNull()
    .references(() => classes.id, { onDelete: 'restrict' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  status: enrollmentStatus('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One enrolment per student per session. A student cannot be in two classes.
  studentSessionUq: uniqueIndex('enrollments_student_session_uq')
    .on(t.studentId, t.sessionId),
  classIdx: index('enrollments_class_idx').on(t.classId, t.status),
  schoolIdx: index('enrollments_school_idx').on(t.schoolId),
}));

/**
 * Subject registration. This is AUTHORITATIVE for what a student sits.
 *
 * The old system treated it as advisory — the paper was shown if the student was
 * registered OR merely in the class — which made registration optional in
 * practice and let students sit subjects they do not offer.
 */
export const studentSubjects = pgTable('student_subjects', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  subjectId: bigint('subject_id', { mode: 'number' }).notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uq: uniqueIndex('student_subjects_uq').on(t.studentId, t.subjectId, t.sessionId),
  schoolIdx: index('student_subjects_school_idx').on(t.schoolId),
}));

// ── Guardians ────────────────────────────────────────────────────────────────

export const guardians = pgTable('guardians', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' })
    .references(() => users.id, { onDelete: 'set null' }),
  fullName: varchar('full_name', { length: 191 }).notNull(),
  email: varchar('email', { length: 191 }),
  phone: varchar('phone', { length: 50 }),
}, (t) => ({
  schoolIdx: index('guardians_school_idx').on(t.schoolId),
}));

export const guardianStudent = pgTable('guardian_student', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  guardianId: bigint('guardian_id', { mode: 'number' }).notNull()
    .references(() => guardians.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  relationship: varchar('relationship', { length: 50 }),
}, (t) => ({
  uq: uniqueIndex('guardian_student_uq').on(t.guardianId, t.studentId),
}));

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * Append-only. The application role is granted INSERT and SELECT, never UPDATE
 * or DELETE — an audit trail that can be edited is not an audit trail.
 *
 * Written for: result publication and correction, question approval, attempt
 * interventions (extra time, device change, forced logout, cancellation),
 * student status changes, permission changes, and platform-operator access to
 * a school's data.
 */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }),
  actorUserId: bigint('actor_user_id', { mode: 'number' }),
  actorRole: varchar('actor_role', { length: 50 }),

  action: varchar('action', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }),
  entityId: bigint('entity_id', { mode: 'number' }),

  // Enough to answer "what did this look like before?" without a backup restore.
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),

  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolIdx: index('audit_school_idx').on(t.schoolId, t.createdAt),
  entityIdx: index('audit_entity_idx').on(t.entityType, t.entityId),
  actorIdx: index('audit_actor_idx').on(t.actorUserId, t.createdAt),
}));
