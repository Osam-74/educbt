/**
 * Papers and attempts — the CBT engine's storage.
 *
 * THE SERVER IS THE SOURCE OF TRUTH.
 *
 * The browser holds a copy so a candidate can keep working through a dropout,
 * but it is never authoritative. Timing, validity and marking are all decided
 * here, because a client clock can be changed and a client submission can be
 * replayed.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, timestamp,
  integer, numeric, uniqueIndex, index, pgEnum, jsonb, inet,
} from 'drizzle-orm/pg-core';
import { schools, subjects, classes, classLevels, departments } from './core';
import { students, staff } from './people';
import { examSeries, questions, questionOptions } from './questions';

export const paperStatus = pgEnum('paper_status', [
  'draft', 'published', 'closed', 'cancelled',
]);

export const attemptStatus = pgEnum('attempt_status', [
  'in_progress', 'submitted', 'auto_submitted', 'expired', 'cancelled',
]);

/**
 * Integrity signals raised by the candidate's own browser.
 *
 * Advisory, not proof — a determined student can block the report. Worth having
 * anyway: the common case is someone alt-tabbing without thinking, and a record
 * of that is what an invigilator needs for a quiet word.
 */
export const attemptEventType = pgEnum('attempt_event_type', [
  'window_blur', 'tab_hidden', 'right_click', 'fullscreen_exit',
  'second_session', 'resumed', 'question_flagged',
]);

// ── Papers ───────────────────────────────────────────────────────────────────

export const examPapers = pgTable('exam_papers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  seriesId: bigint('series_id', { mode: 'number' }).notNull()
    .references(() => examSeries.id, { onDelete: 'cascade' }),
  subjectId: bigint('subject_id', { mode: 'number' }).notNull()
    .references(() => subjects.id, { onDelete: 'restrict' }),

  levelId: bigint('level_id', { mode: 'number' })
    .references(() => classLevels.id, { onDelete: 'set null' }),
  departmentId: bigint('department_id', { mode: 'number' })
    .references(() => departments.id, { onDelete: 'set null' }),
  classId: bigint('class_id', { mode: 'number' })
    .references(() => classes.id, { onDelete: 'set null' }),

  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds').default(3600).notNull(),

  // How many of the pooled questions each candidate answers.
  questionCount: integer('question_count').default(0).notNull(),

  shuffleQuestions: boolean('shuffle_questions').default(true).notNull(),
  shuffleOptions: boolean('shuffle_options').default(true).notNull(),

  status: paperStatus('status').default('draft').notNull(),
  invigilatorStaffId: bigint('invigilator_staff_id', { mode: 'number' })
    .references(() => staff.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  seriesIdx: index('papers_series_idx').on(t.seriesId, t.status),
  schoolIdx: index('papers_school_idx').on(t.schoolId),
}));

/** The pool a paper draws from. */
export const paperQuestions = pgTable('paper_questions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  paperId: bigint('paper_id', { mode: 'number' }).notNull()
    .references(() => examPapers.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull()
    .references(() => questions.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => ({
  uq: uniqueIndex('paper_questions_uq').on(t.paperId, t.questionId),
}));

// ── Attempts ─────────────────────────────────────────────────────────────────

export const attempts = pgTable('attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  paperId: bigint('paper_id', { mode: 'number' }).notNull()
    .references(() => examPapers.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull()
    .references(() => students.id, { onDelete: 'cascade' }),

  status: attemptStatus('status').default('in_progress').notNull(),

  /**
   * SERVER TIME, ALWAYS.
   *
   * `expiresAt` is computed when the attempt starts and is the only thing that
   * decides whether an answer is still accepted. The client renders a countdown
   * for the candidate's benefit; it has no authority. A device clock can be
   * wound back, and a paused laptop does not pause the examination.
   */
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),

  // Granted by an invigilator, in seconds, and added to expiresAt.
  extensionSeconds: integer('extension_seconds').default(0).notNull(),

  /**
   * The question order THIS candidate sees, fixed at start.
   *
   * Stored rather than recomputed so a resume on a different device shows the
   * same paper in the same order. Recomputing a shuffle would reorder the paper
   * mid-examination.
   */
  questionOrder: jsonb('question_order').$type<number[]>().default([]).notNull(),

  score: numeric('score', { precision: 8, scale: 2 }),
  maxScore: numeric('max_score', { precision: 8, scale: 2 }),

  /** Student bookmarks — "come back to this". NOT an integrity concern. */
  bookmarkCount: integer('bookmark_count').default(0).notNull(),

  /** Integrity incidents. Counted separately: conflating the two made a careful
   *  candidate look like a suspected cheat. */
  integrityCount: integer('integrity_count').default(0).notNull(),

  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  deviceId: varchar('device_id', { length: 100 }),
}, (t) => ({
  // One attempt per student per paper. The engine resumes rather than restarts.
  uq: uniqueIndex('attempts_student_paper_uq').on(t.paperId, t.studentId),
  studentIdx: index('attempts_student_idx').on(t.studentId, t.status),
  paperIdx: index('attempts_paper_idx').on(t.paperId, t.status),
  expiryIdx: index('attempts_expiry_idx').on(t.status, t.expiresAt),
}));

export const attemptAnswers = pgTable('attempt_answers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  attemptId: bigint('attempt_id', { mode: 'number' }).notNull()
    .references(() => attempts.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull()
    .references(() => questions.id, { onDelete: 'cascade' }),

  optionId: bigint('option_id', { mode: 'number' })
    .references(() => questionOptions.id, { onDelete: 'set null' }),
  textAnswer: text('text_answer'),

  bookmarked: boolean('bookmarked').default(false).notNull(),

  // Set by the marker, never by the client.
  awardedMarks: numeric('awarded_marks', { precision: 6, scale: 2 }),
  markedBy: bigint('marked_by', { mode: 'number' }),
  markedAt: timestamp('marked_at', { withTimezone: true }),

  /**
   * Client-generated, so a retried save updates the same row.
   *
   * A dropped connection leaves the browser unsure whether the answer landed,
   * and it retries. Without this the retry writes a second row and the marker
   * sees the question answered twice.
   */
  idempotencyKey: varchar('idempotency_key', { length: 100 }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One answer per question per attempt: a save is an UPSERT, never an insert.
  uq: uniqueIndex('attempt_answers_uq').on(t.attemptId, t.questionId),
  attemptIdx: index('attempt_answers_attempt_idx').on(t.attemptId),
}));

export const attemptEvents = pgTable('attempt_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  attemptId: bigint('attempt_id', { mode: 'number' }).notNull()
    .references(() => attempts.id, { onDelete: 'cascade' }),
  eventType: attemptEventType('event_type').notNull(),
  payload: jsonb('payload'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  attemptIdx: index('attempt_events_attempt_idx').on(t.attemptId, t.createdAt),
}));
