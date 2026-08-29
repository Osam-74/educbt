/**
 * Results storage. Table lives here so drizzle-kit discovers it; the
 * compilation logic lives in src/lib/exam/results.ts.
 */

import {
  pgTable, bigserial, bigint, numeric, varchar, integer, timestamp,
  uniqueIndex, index, boolean, pgEnum, jsonb,
} from 'drizzle-orm/pg-core';

/**
 * A computed result is not a published one, and a published one is not final.
 * See src/domain/academic.ts for the permitted transitions.
 */
export const resultState = pgEnum('result_state', [
  'draft', 'compiled', 'reviewed', 'published', 'locked',
]);

export const subjectResults = pgTable('subject_results', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  studentId: bigint('student_id', { mode: 'number' }).notNull(),
  subjectId: bigint('subject_id', { mode: 'number' }).notNull(),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(),
  termId: bigint('term_id', { mode: 'number' }).notNull(),

  caTotal: numeric('ca_total', { precision: 6, scale: 2 }).default('0').notNull(),
  examTotal: numeric('exam_total', { precision: 6, scale: 2 }).default('0').notNull(),
  total: numeric('total', { precision: 6, scale: 2 }).default('0').notNull(),

  // Stored, not derived: a published result must not change when a school edits
  // its grading scale months later.
  grade: varchar('grade', { length: 10 }).default('').notNull(),
  remark: varchar('remark', { length: 100 }).default('').notNull(),
  subjectPosition: integer('subject_position').default(0).notNull(),
  classSize: integer('class_size').default(0).notNull(),

  /**
   * WHICH SCALE PRODUCED THIS GRADE.
   *
   * Without it, a grade cannot be explained a year later — and a school that
   * revises its bands has no way to show that last year's B3 was correct under
   * the rules in force at the time.
   */
  gradingScaleId: varchar('grading_scale_id', { length: 50 }).default('').notNull(),
  gradingScaleVersion: integer('grading_scale_version').default(0).notNull(),

  /**
   * The ranking policy in force when this position was calculated. A school
   * that switches from competition to dense ranking mid-year must not leave
   * last term's positions unexplainable.
   */
  rankingPolicy: jsonb('ranking_policy').$type<Record<string, unknown>>(),

  /** Whether every component had a score. An incomplete total is not a result. */
  complete: boolean('complete').default(false).notNull(),

  state: resultState('state').default('draft').notNull(),

  // Kept as a derived convenience for queries; `state` is authoritative.
  published: boolean('published').default(false).notNull(),

  compiledAt: timestamp('compiled_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
}, (t) => ({
  uq: uniqueIndex('subject_results_uq').on(t.studentId, t.subjectId, t.sessionId, t.termId),
  scopeIdx: index('subject_results_scope_idx').on(t.schoolId, t.sessionId, t.termId, t.subjectId),
}));
