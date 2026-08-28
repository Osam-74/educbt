/**
 * Question bank.
 *
 * Two constraints in this file exist because their absence caused weeks of
 * failures in the WordPress system. Both are load-bearing:
 *
 *   1. A question set is identified by its scope AND the series it belongs to
 *      AND whether it follows the WAEC structure. Leaving those out of the
 *      unique key meant a CA test, a practice paper and the terminal
 *      examination for the same subject were the same row — so writing practice
 *      questions silently filled the examination paper, and creating a second
 *      set failed with a duplicate-key error the user saw as "could not start a
 *      question set".
 *
 *   2. `seriesId` is NOT NULL with a default of 0, never nullable. Postgres
 *      treats NULLs as distinct in a unique index, so a nullable column would
 *      let duplicate terminal sets through the very constraint meant to stop
 *      them.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, timestamp,
  integer, numeric, uniqueIndex, index, pgEnum, jsonb,
} from 'drizzle-orm/pg-core';
import { schools, academicSessions, terms, subjects, classLevels, departments, classes } from './core';
import { staff } from './people';

// ── Enums ────────────────────────────────────────────────────────────────────

/**
 * What a series is for. The three behave differently in ways that matter:
 *
 *   examination  objective and theory submitted together, reviewed, scheduled
 *   ca_test      objective only, no approval, marked the morning after
 *   practice     objective only, no approval, no timetable, always available
 */
export const seriesType = pgEnum('series_type', ['examination', 'ca_test', 'practice']);

export const seriesStatus = pgEnum('series_status', [
  'draft', 'open', 'composed', 'published', 'closed', 'cancelled',
]);

export const examType = pgEnum('exam_type', ['objective', 'theory']);

export const deliveryMode = pgEnum('delivery_mode', ['cbt', 'written']);

export const setStatus = pgEnum('set_status', [
  'draft', 'submitted', 'under_review', 'returned', 'approved', 'published',
]);

export const approvalStatus = pgEnum('approval_status', [
  // Defaults to 'pending'. It defaulted to 'approved' once, which meant every
  // question a teacher typed was live before anyone had read it.
  'pending', 'approved', 'revision',
]);

export const questionType = pgEnum('question_type', [
  'single_choice', 'multiple_choice', 'true_false', 'theory',
]);

export const passageType = pgEnum('passage_type', [
  'comprehension', 'cloze', 'summary', 'reading_text', 'instructions', 'data', 'diagram',
]);

// ── Series ───────────────────────────────────────────────────────────────────

export const examSeries = pgTable('exam_series', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  termId: bigint('term_id', { mode: 'number' })
    .references(() => terms.id, { onDelete: 'cascade' }),

  title: varchar('title', { length: 191 }).notNull(),
  seriesType: seriesType('series_type').default('examination').notNull(),

  // Which assessment column a CA test's marks land in.
  componentId: bigint('component_id', { mode: 'number' }),

  /**
   * The window in which TEACHERS SUBMIT QUESTIONS — not the sitting dates.
   * The sitting period is set when the timetable is built, because that is when
   * the school actually knows it. Conflating the two meant a teacher could not
   * write questions until the day the exam started.
   */
  questionsOpenFrom: timestamp('questions_open_from', { withTimezone: true }),
  questionsOpenTo: timestamp('questions_open_to', { withTimezone: true }),

  questionsPerStudent: integer('questions_per_student').default(0).notNull(),
  durationMinutes: integer('duration_minutes').default(0).notNull(),

  status: seriesStatus('status').default('draft').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolIdx: index('series_school_idx').on(t.schoolId, t.sessionId, t.termId),
  typeIdx: index('series_type_idx').on(t.schoolId, t.seriesType, t.status),
}));

// ── Passages ─────────────────────────────────────────────────────────────────

/**
 * A shared stimulus: a comprehension text, a cloze passage, a data table.
 * Several questions point at one passage, so a candidate reads it once.
 */
export const passages = pgTable('passages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  subjectId: bigint('subject_id', { mode: 'number' })
    .references(() => subjects.id, { onDelete: 'set null' }),

  title: varchar('title', { length: 191 }).notNull(),
  passageType: passageType('passage_type').default('comprehension').notNull(),

  // Paragraph breaks are preserved. A comprehension passage without them is far
  // harder to read under exam conditions.
  body: text('body').notNull(),
  imageUrl: text('image_url'),

  authorStaffId: bigint('author_staff_id', { mode: 'number' })
    .references(() => staff.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  schoolIdx: index('passages_school_idx').on(t.schoolId, t.subjectId),
}));

// ── Question sets ────────────────────────────────────────────────────────────

export const questionSets = pgTable('question_sets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull()
    .references(() => academicSessions.id, { onDelete: 'cascade' }),
  termId: bigint('term_id', { mode: 'number' }).notNull()
    .references(() => terms.id, { onDelete: 'cascade' }),

  subjectId: bigint('subject_id', { mode: 'number' }).notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),

  /**
   * Keyed on LEVEL and DEPARTMENT, never the class arm. SS1 Science A and
   * SS1 Science B sit the same paper; keying on the arm meant a teacher wrote
   * the same questions twice and the two copies drifted apart.
   */
  levelId: bigint('level_id', { mode: 'number' }).notNull()
    .references(() => classLevels.id, { onDelete: 'cascade' }),
  departmentId: bigint('department_id', { mode: 'number' })
    .references(() => departments.id, { onDelete: 'set null' }),

  // A representative arm, for display only. Never part of identity.
  classId: bigint('class_id', { mode: 'number' })
    .references(() => classes.id, { onDelete: 'set null' }),

  examType: examType('exam_type').notNull(),
  deliveryMode: deliveryMode('delivery_mode').default('cbt').notNull(),
  waecMode: boolean('waec_mode').default(false).notNull(),

  // 0 means the terminal examination. See the note at the top of this file on
  // why this is NOT NULL.
  seriesId: bigint('series_id', { mode: 'number' }).default(0).notNull(),

  teacherId: bigint('teacher_id', { mode: 'number' })
    .references(() => staff.id, { onDelete: 'set null' }),

  defaultMarks: numeric('default_marks', { precision: 6, scale: 2 }).default('1.00').notNull(),
  minRequired: integer('min_required').default(0).notNull(),

  status: setStatus('status').default('draft').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedBy: bigint('submitted_by', { mode: 'number' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: bigint('reviewed_by', { mode: 'number' }),
  reviewerComment: text('reviewer_comment'),
  revisionHistory: jsonb('revision_history').$type<unknown[]>().default([]).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  /**
   * THE SCOPE KEY. Every column here is part of what makes a set distinct.
   * Dropping any one of them merges two different papers into one row.
   */
  scopeUq: uniqueIndex('question_sets_scope_uq').on(
    t.schoolId, t.sessionId, t.termId, t.subjectId,
    t.levelId, t.departmentId, t.examType, t.seriesId, t.waecMode,
  ),
  schoolIdx: index('sets_school_idx').on(t.schoolId, t.status),
  teacherIdx: index('sets_teacher_idx').on(t.teacherId),
}));

// ── Questions ────────────────────────────────────────────────────────────────

export const questions = pgTable('questions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  questionSetId: bigint('question_set_id', { mode: 'number' }).notNull()
    .references(() => questionSets.id, { onDelete: 'cascade' }),

  questionText: text('question_text').notNull(),
  questionType: questionType('question_type').default('single_choice').notNull(),
  imageUrl: text('image_url'),

  // Shown above the question, in the candidate's reading order.
  instructions: text('instructions'),

  passageId: bigint('passage_id', { mode: 'number' })
    .references(() => passages.id, { onDelete: 'set null' }),

  // e.g. "paper2:antonyms" for a WAEC-structured paper. Empty otherwise.
  section: varchar('section', { length: 100 }).default('').notNull(),

  marks: numeric('marks', { precision: 6, scale: 2 }).default('1.00').notNull(),
  sequence: integer('sequence').default(0).notNull(),

  // Cloze gaps must follow the passage. Shuffling them makes the paper
  // unanswerable, so they opt out of randomisation.
  noShuffle: boolean('no_shuffle').default(false).notNull(),

  markingGuide: text('marking_guide'),
  explanation: text('explanation'),

  approvalStatus: approvalStatus('approval_status').default('pending').notNull(),
  reviewerComment: text('reviewer_comment'),
  reviewedBy: bigint('reviewed_by', { mode: 'number' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

  parentId: bigint('parent_id', { mode: 'number' }),
  partLabel: varchar('part_label', { length: 20 }),

  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  setIdx: index('questions_set_idx').on(t.questionSetId, t.status),
  sectionIdx: index('questions_section_idx').on(t.questionSetId, t.section),
  schoolIdx: index('questions_school_idx').on(t.schoolId),
}));

/**
 * Options.
 *
 * `isCorrect` LIVES HERE AND MUST NEVER LEAVE THE SERVER.
 *
 * Every read path that serves a paper to a candidate selects option id and text
 * only. A student with dev tools open must not be able to read the answers —
 * that single failure invalidates every examination ever sat on the platform.
 * See `publicOptionsForPaper()` in src/lib/exam/paper.ts, which is the only
 * sanctioned way to send options to a browser.
 */
export const questionOptions = pgTable('question_options', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull()
    .references(() => questions.id, { onDelete: 'cascade' }),

  optionKey: varchar('option_key', { length: 5 }),
  optionText: text('option_text').notNull(),
  imageUrl: text('image_url'),
  isCorrect: boolean('is_correct').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => ({
  questionIdx: index('options_question_idx').on(t.questionId, t.sortOrder),
}));
