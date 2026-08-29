/**
 * Continuous assessment scores, entered by the subject teacher.
 *
 * Separate from examination marks, which come from the CBT engine. A CA score
 * is typed by a person and therefore needs its own audit trail — who entered
 * it, and when it last changed.
 */

import {
  pgTable, bigserial, bigint, numeric, varchar, timestamp, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

export const assessmentScores = pgTable('assessment_scores', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  studentId: bigint('student_id', { mode: 'number' }).notNull(),
  subjectId: bigint('subject_id', { mode: 'number' }).notNull(),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(),
  termId: bigint('term_id', { mode: 'number' }).notNull(),

  // 'ca1', 'ca2', 'assignment' — matches the school's configured components.
  componentKey: varchar('component_key', { length: 50 }).notNull(),

  score: numeric('score', { precision: 6, scale: 2 }).default('0').notNull(),
  maxScore: numeric('max_score', { precision: 6, scale: 2 }).default('0').notNull(),

  enteredBy: bigint('entered_by', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  /**
   * THE FULL ACADEMIC CONTEXT.
   *
   * school, student, subject, session, term, component — every one of them.
   *
   * The key previously omitted schoolId and sessionId. A term id implies its
   * session today, but relying on that is exactly the assumption that breaks
   * when a school reuses term numbering or a migration renumbers rows. An
   * upsert keyed too loosely does not fail loudly — it OVERWRITES a score that
   * belonged to another context, and nobody notices until a parent asks why a
   * mark changed.
   */
  uq: uniqueIndex('assessment_scores_uq')
    .on(t.schoolId, t.studentId, t.subjectId, t.sessionId, t.termId, t.componentKey),
  scopeIdx: index('assessment_scores_scope_idx')
    .on(t.schoolId, t.subjectId, t.termId),
}));
