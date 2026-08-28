/**
 * Tenancy and academic structure.
 *
 * Every school-owned table carries `schoolId`. That column is not decoration —
 * Row-Level Security policies (see src/db/rls.sql) filter on it, so a query that
 * forgets its scope returns nothing rather than another school's data.
 *
 * Conventions that hold across the whole schema:
 *
 *   - timestamps are `timestamptz` and stored in UTC. The application renders in
 *     Africa/Lagos. The old system mixed local and UTC helpers and that produced
 *     off-by-an-hour bugs in exam windows.
 *   - money and marks are `numeric`, never float. A rounding error on a report
 *     card destroys a school's trust permanently.
 *   - controlled vocabularies are Postgres enums, so a typo is a database error
 *     rather than a row nobody can find later.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, timestamp,
  integer, uniqueIndex, index, pgEnum, jsonb,
} from 'drizzle-orm/pg-core';

// ── Enums ────────────────────────────────────────────────────────────────────

export const schoolStatus = pgEnum('school_status', [
  'active', 'suspended', 'archived',
]);

/**
 * Student standing.
 *
 * The legacy system used 'inactive' to mean suspended, which is why the UI said
 * one thing and the database another. The migration maps legacy 'inactive' to
 * 'suspended' explicitly; the ambiguous name does not survive.
 */
export const studentStatus = pgEnum('student_status', [
  'active', 'suspended', 'withdrawn', 'expelled', 'pending_approval', 'graduated',
]);

export const staffStatus = pgEnum('staff_status', ['active', 'suspended', 'left']);

export const stage = pgEnum('stage', ['junior', 'senior', 'both']);

export const subjectCategory = pgEnum('subject_category', ['core', 'elective']);

export const enrollmentStatus = pgEnum('enrollment_status', [
  'active', 'inactive', 'pending_approval', 'transferred',
]);

// ── Schools ──────────────────────────────────────────────────────────────────

export const schools = pgTable('schools', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 191 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),

  // A domain is a ROUTING signal only. Resolving a school from the hostname must
  // never by itself grant access — authorisation is checked separately on every
  // protected action.
  subdomain: varchar('subdomain', { length: 63 }),
  customDomain: varchar('custom_domain', { length: 191 }),

  logoUrl: text('logo_url'),
  address: text('address'),
  phone: varchar('phone', { length: 50 }),
  email: varchar('email', { length: 191 }),
  website: varchar('website', { length: 191 }),
  principalName: varchar('principal_name', { length: 191 }),
  principalPhotoUrl: text('principal_photo_url'),

  // Grading scales, assessment weighting, result policy. Versioned separately so
  // a change today cannot silently rewrite a result published last term.
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),

  status: schoolStatus('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  codeUq: uniqueIndex('schools_code_uq').on(t.code),
  subdomainUq: uniqueIndex('schools_subdomain_uq').on(t.subdomain),
  customDomainUq: uniqueIndex('schools_custom_domain_uq').on(t.customDomain),
}));

// ── Academic calendar ────────────────────────────────────────────────────────

export const academicSessions = pgTable('academic_sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 100 }).notNull(),
  startsOn: timestamp('starts_on', { withTimezone: true }),
  endsOn: timestamp('ends_on', { withTimezone: true }),
  isCurrent: boolean('is_current').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolTitleUq: uniqueIndex('sessions_school_title_uq').on(t.schoolId, t.title),
  schoolIdx: index('sessions_school_idx').on(t.schoolId),
}));

export const terms = pgTable('terms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 100 }).notNull(),
  position: integer('position').default(1).notNull(),
  startsOn: timestamp('starts_on', { withTimezone: true }),
  endsOn: timestamp('ends_on', { withTimezone: true }),
  isCurrent: boolean('is_current').default(false).notNull(),
}, (t) => ({
  sessionPosUq: uniqueIndex('terms_session_position_uq').on(t.sessionId, t.position),
  schoolIdx: index('terms_school_idx').on(t.schoolId),
}));

// ── Class structure ──────────────────────────────────────────────────────────

export const classLevels = pgTable('class_levels', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  stage: stage('stage').default('junior').notNull(),
  levelOrder: integer('level_order').default(0).notNull(),
}, (t) => ({
  schoolNameUq: uniqueIndex('levels_school_name_uq').on(t.schoolId, t.name),
}));

export const departments = pgTable('departments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => ({
  schoolNameUq: uniqueIndex('departments_school_name_uq').on(t.schoolId, t.name),
}));

/**
 * A class is one ARM — "SS1 Science A". The level and department carry the
 * academic meaning; the arm is just which room they sit in.
 *
 * Question sets are keyed on level + department, never on the arm, because SS1
 * Science A and SS1 Science B sit the same paper.
 */
export const classes = pgTable('classes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  levelId: bigint('level_id', { mode: 'number' }).notNull()
    .references(() => classLevels.id, { onDelete: 'restrict' }),
  departmentId: bigint('department_id', { mode: 'number' })
    .references(() => departments.id, { onDelete: 'set null' }),
  arm: varchar('arm', { length: 20 }),
  displayName: varchar('display_name', { length: 150 }).notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
}, (t) => ({
  scopeUq: uniqueIndex('classes_scope_uq')
    .on(t.schoolId, t.levelId, t.departmentId, t.arm),
  schoolIdx: index('classes_school_idx').on(t.schoolId),
}));

// ── Subjects ─────────────────────────────────────────────────────────────────

export const subjects = pgTable('subjects', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),

  // The code is what distinguishes junior Mathematics (MTH-J) from senior
  // General Mathematics (MTH). Without it a teacher sees two identical rows.
  code: varchar('code', { length: 50 }).notNull(),

  stage: stage('stage').default('both').notNull(),
  category: subjectCategory('category').default('elective').notNull(),
  departmentId: bigint('department_id', { mode: 'number' })
    .references(() => departments.id, { onDelete: 'set null' }),
  isCompulsory: boolean('is_compulsory').default(false).notNull(),

  // Retired, not deleted, once results reference it. Deleting a subject that
  // appears on a published report card makes that record unreadable.
  status: varchar('status', { length: 20 }).default('active').notNull(),
}, (t) => ({
  schoolCodeUq: uniqueIndex('subjects_school_code_uq').on(t.schoolId, t.code),
  schoolIdx: index('subjects_school_idx').on(t.schoolId),
}));
