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
import { staff, students } from './people';

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

/**
 * How this series (CA test or examination) is assessed:
 *
 *   cbt      every subject is a CBT test — the Written option is hidden from
 *            teachers in the Question Bank; they can only submit CBT questions.
 *   written  every subject is on paper — the CBT option is hidden; teachers
 *            submit written intent only, which clears immediately (nothing
 *            to review) exactly as submitSet() already does today.
 *   mixed    each subject-teacher CHOOSES cbt or written for their own
 *            subject (as the Question Bank has always allowed). The
 *            difference from plain 'written'/'cbt': a written declaration
 *            under 'mixed' is an intent that itself needs review — it goes
 *            to the exam office as a normal submission rather than
 *            auto-clearing, because in a mixed series nobody but the office
 *            has agreed yet that THIS subject is the paper-based one.
 */
export const assessmentMode = pgEnum('assessment_mode', ['cbt', 'written', 'mixed']);

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

  // Which CA slot (schools.settings.assessmentComponents[].key, e.g. 'ca1')
  // a CA test's marks count towards — set at "Open assessment window", read
  // by the Exam Papers office UI to label the row; unrelated to the actual
  // score entry path (lib/exam/results.ts enterScore), which is manual.
  caComponentKey: varchar('ca_component_key', { length: 64 }),

  /**
   * The window in which TEACHERS SUBMIT QUESTIONS — not the sitting dates.
   * The sitting period is set when the timetable is built, because that is when
   * the school actually knows it. Conflating the two meant a teacher could not
   * write questions until the day the exam started.
   */
  questionsOpenFrom: timestamp('questions_open_from', { withTimezone: true }),
  questionsOpenTo: timestamp('questions_open_to', { withTimezone: true }),

  /**
   * THE SITTING WINDOW — when candidates may sit papers in this series.
   *
   * Set by the scheduling step, not at creation: a school knows its sitting
   * dates only once it has papers to place. `startAttempt` enforces it for
   * examination and CA series; practice papers are exempt because practice
   * is always available.
   */
  sittingOpensAt: timestamp('sitting_opens_at', { withTimezone: true }),
  sittingClosesAt: timestamp('sitting_closes_at', { withTimezone: true }),

  questionsPerStudent: integer('questions_per_student').default(0).notNull(),
  durationMinutes: integer('duration_minutes').default(0).notNull(),

  status: seriesStatus('status').default('draft').notNull(),
  assessmentMode: assessmentMode('assessment_mode').default('mixed').notNull(),
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

  // Said once for the whole passage ("Read the passage and answer questions 1 to 4"), not repeated on each question.
  instructions: text('instructions'),
  classLevel: varchar('class_level', { length: 50 }).default('').notNull(),

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
  /** Theory only: the paper is answered on paper; students read it on screen, the teacher enters the marks. */
  theoryOnPaper: boolean('theory_on_paper').default(false).notNull(),
  /** Theory only: how many theory questions each student answers. 0 = every student answers every question. */
  theoryAnswerCount: integer('theory_answer_count').default(0).notNull(),

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
  // Reading order inside a passage: 0, 1, 2... Standalone questions stay 0.
  passagePosition: integer('passage_position').default(0).notNull(),

  // e.g. "paper2:antonyms" for a WAEC-structured paper. Empty otherwise.
  section: varchar('section', { length: 100 }).default('').notNull(),

  /** Theory only: every student's paper carries this question, whatever the draw. */
  isCompulsory: boolean('is_compulsory').default(false).notNull(),
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
  passageIdx: index('questions_passage_idx').on(t.passageId, t.passagePosition),
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

// ─────────────────────────────────────────────────────────────────────────────
// The standalone question bank (migration 0029).
//
// The WordPress plugin keeps questions OUTSIDE any exam set, with subject, class, topic, difficulty, Bloom level,
// exam year, duration, explanation and marking guide. SaaS questions must belong to a set, so these details had
// nowhere to live. These tables hold them without touching the set-based flow that exam composition relies on.
// ─────────────────────────────────────────────────────────────────────────────
export const bankQuestions = pgTable('bank_questions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  subjectId: bigint('subject_id', { mode: 'number' }).references(() => subjects.id, { onDelete: 'set null' }),
  /** the subject as the school wrote it; kept even when it matches no subject, so nothing is lost */
  subjectName: varchar('subject_name', { length: 150 }).default('').notNull(),
  classLabel: varchar('class_label', { length: 100 }).default('').notNull(),
  departmentLabel: varchar('department_label', { length: 100 }).default('').notNull(),
  section: varchar('section', { length: 100 }).default('').notNull(),
  topic: varchar('topic', { length: 255 }).default('').notNull(),
  subTopic: varchar('sub_topic', { length: 255 }).default('').notNull(),
  difficulty: varchar('difficulty', { length: 30 }).default('').notNull(),
  bloomLevel: varchar('bloom_level', { length: 50 }).default('').notNull(),
  learningObjective: text('learning_objective').default('').notNull(),
  examinationType: varchar('examination_type', { length: 100 }).default('').notNull(),
  examinationYear: varchar('examination_year', { length: 10 }).default('').notNull(),
  questionType: varchar('question_type', { length: 20 }).default('objective').notNull(),
  marks: numeric('marks', { precision: 8, scale: 2 }).default('1').notNull(),
  estimatedSeconds: integer('estimated_seconds').default(0).notNull(),
  questionText: text('question_text').default('').notNull(),
  passageText: text('passage_text').default('').notNull(),
  imageUrl: text('image_url'),
  explanation: text('explanation').default('').notNull(),
  markingGuide: text('marking_guide').default('').notNull(),
  status: varchar('status', { length: 20 }).default('draft').notNull(),
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending').notNull(),
  reviewNote: text('review_note').default('').notNull(),
  reviewedBy: bigint('reviewed_by', { mode: 'number' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  sourceMethod: varchar('source_method', { length: 30 }).default('manual').notNull(),
  authorStaffId: bigint('author_staff_id', { mode: 'number' }),
  parentId: bigint('parent_id', { mode: 'number' }),
  partLabel: varchar('part_label', { length: 10 }).default('').notNull(),
  sequence: integer('sequence').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  subjectIdx: index('bank_questions_school_subject_idx').on(t.schoolId, t.subjectId, t.status),
  topicIdx: index('bank_questions_topic_idx').on(t.schoolId, t.topic),
}));

export const bankQuestionOptions = pgTable('bank_question_options', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull().references(() => bankQuestions.id, { onDelete: 'cascade' }),
  optionKey: varchar('option_key', { length: 10 }).default('').notNull(),
  optionText: text('option_text').default('').notNull(),
  imageUrl: text('image_url'),
  isCorrect: boolean('is_correct').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => ({ questionIdx: index('bank_question_options_question_idx').on(t.questionId, t.sortOrder) }));

export const bankQuestionParts = pgTable('bank_question_parts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull().references(() => bankQuestions.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 10 }).default('').notNull(),
  text: text('text').default('').notNull(),
  marks: numeric('marks', { precision: 8, scale: 2 }).default('0').notNull(),
  sequence: integer('sequence').default(0).notNull(),
}, (t) => ({ questionIdx: index('bank_question_parts_question_idx').on(t.questionId, t.sequence) }));

// ─────────────────────────────────────────────────────────────────────────────
// Exam history from the WordPress plugin (migration 0030). READ-ONLY.
//
// A plugin paper draws from the standalone question bank, and a SaaS attempt can only point at a set-based
// question, so they cannot be re-created as live exams without inventing sets the school never made. They are kept
// as history: the queryable facts are real columns, and the plugin's original row is kept verbatim in `source`
// so no column is ever lost. Nothing here feeds a live exam, a result or a report card.
// ─────────────────────────────────────────────────────────────────────────────
export const legacyExamPapers = pgTable('legacy_exam_papers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(),
  sourceId: bigint('source_id', { mode: 'number' }).notNull(),
  seriesSourceId: bigint('series_source_id', { mode: 'number' }),
  title: varchar('title', { length: 255 }).default('').notNull(),
  seriesType: varchar('series_type', { length: 30 }).default('').notNull(),
  subjectId: bigint('subject_id', { mode: 'number' }),
  subjectName: varchar('subject_name', { length: 150 }).default('').notNull(),
  classId: bigint('class_id', { mode: 'number' }),
  className: varchar('class_name', { length: 100 }).default('').notNull(),
  sessionId: bigint('session_id', { mode: 'number' }),
  termId: bigint('term_id', { mode: 'number' }),
  status: varchar('status', { length: 30 }).default('').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds').default(0).notNull(),
  questionCount: integer('question_count').default(0).notNull(),
  totalMarks: numeric('total_marks', { precision: 10, scale: 2 }).default('0').notNull(),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
  questions: jsonb('questions').$type<unknown[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sourceUq: uniqueIndex('legacy_exam_papers_source_uq').on(t.schoolId, t.kind, t.sourceId),
}));

export const legacyExamAttempts = pgTable('legacy_exam_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(),
  sourceId: bigint('source_id', { mode: 'number' }).notNull(),
  paperId: bigint('paper_id', { mode: 'number' }).references(() => legacyExamPapers.id, { onDelete: 'set null' }),
  studentId: bigint('student_id', { mode: 'number' }).references(() => students.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 30 }).default('').notNull(),
  submitReason: varchar('submit_reason', { length: 30 }).default('').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  gradedAt: timestamp('graded_at', { withTimezone: true }),
  extensionSeconds: integer('extension_seconds').default(0).notNull(),
  rawScore: numeric('raw_score', { precision: 10, scale: 2 }),
  maxScore: numeric('max_score', { precision: 10, scale: 2 }),
  percentage: numeric('percentage', { precision: 6, scale: 2 }),
  flagCount: integer('flag_count').default(0).notNull(),
  integrityCount: integer('integrity_count').default(0).notNull(),
  questionOrder: jsonb('question_order').$type<unknown[]>().notNull(),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
}, (t) => ({
  sourceUq: uniqueIndex('legacy_exam_attempts_source_uq').on(t.schoolId, t.kind, t.sourceId),
  studentIdx: index('legacy_exam_attempts_student_idx').on(t.schoolId, t.studentId),
}));

export const legacyAttemptAnswers = pgTable('legacy_attempt_answers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  attemptId: bigint('attempt_id', { mode: 'number' }).notNull().references(() => legacyExamAttempts.id, { onDelete: 'cascade' }),
  position: integer('position').default(0).notNull(),
  questionSourceId: bigint('question_source_id', { mode: 'number' }),
  questionText: text('question_text').default('').notNull(),
  chosenOption: text('chosen_option'),
  correctOption: text('correct_option'),
  answerText: text('answer_text'),
  isCorrect: boolean('is_correct'),
  marksAwarded: numeric('marks_awarded', { precision: 8, scale: 2 }),
  marksAvailable: numeric('marks_available', { precision: 8, scale: 2 }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
}, (t) => ({
  attemptIdx: index('legacy_attempt_answers_attempt_idx').on(t.attemptId, t.position),
}));

export const legacyAttemptEvents = pgTable('legacy_attempt_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  attemptId: bigint('attempt_id', { mode: 'number' }).notNull().references(() => legacyExamAttempts.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 60 }).default('').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
}, (t) => ({
  attemptIdx: index('legacy_attempt_events_attempt_idx').on(t.attemptId),
}));
