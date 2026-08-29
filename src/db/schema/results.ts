/**
 * Results storage. Table lives here so drizzle-kit discovers it; the
 * compilation logic lives in src/lib/exam/results.ts.
 */

import {
  pgTable, bigserial, bigint, numeric, varchar, integer, timestamp,
  uniqueIndex, index, boolean,
} from 'drizzle-orm/pg-core';

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

  published: boolean('published').default(false).notNull(),
  compiledAt: timestamp('compiled_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uq: uniqueIndex('subject_results_uq').on(t.studentId, t.subjectId, t.sessionId, t.termId),
  scopeIdx: index('subject_results_scope_idx').on(t.schoolId, t.sessionId, t.termId, t.subjectId),
}));
