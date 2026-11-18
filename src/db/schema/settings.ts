import { pgTable, bigserial, bigint, varchar, text, integer, jsonb, timestamp, numeric, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { schools } from './core';
import { staff, students } from './people';
import type { GradingScale } from '@/domain/academic';

export const gradingScaleVersions = pgTable('grading_scale_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  scaleId: varchar('scale_id', { length: 50 }).notNull(), version: integer('version').notNull(),
  snapshot: jsonb('snapshot').$type<GradingScale>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('grading_scale_versions_uq').on(t.schoolId, t.scaleId, t.version) }));

export const staffSignatures = pgTable('staff_signatures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 }).notNull(), name: varchar('name', { length: 191 }).notNull(),
  type: varchar('type', { length: 10 }).notNull(), data: text('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('staff_signatures_uq').on(t.schoolId, t.staffId, t.role) }));

export const staffRemarkRanges = pgTable('staff_remark_ranges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 }).notNull(),
  ranges: jsonb('ranges').$type<Array<{ min: number; remark: string }>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('staff_remark_ranges_uq').on(t.schoolId, t.staffId, t.role) }));

export const reportRemarks = pgTable('report_remarks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull().references(() => students.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(), termId: bigint('term_id', { mode: 'number' }).notNull(),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 }).notNull(), source: varchar('source', { length: 10 }).notNull(), remark: text('remark').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('report_remarks_uq').on(t.schoolId, t.studentId, t.sessionId, t.termId, t.role) }));

/**
 * One row per student per term: the human side of a term's report that the SaaS cannot recompute.
 *
 * Averages, totals and class positions are NOT authoritative here: the report page still derives them live
 * from subject_results, so an edit to a score can never leave a stale position behind. The figures stored
 * here are a snapshot, kept so that a school moved over from the WordPress plugin keeps what its old
 * report cards said, and so an old report can be explained.
 */
export const termSummaries = pgTable('term_summaries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  studentId: bigint('student_id', { mode: 'number' }).notNull().references(() => students.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(),
  termId: bigint('term_id', { mode: 'number' }).notNull(),
  classId: bigint('class_id', { mode: 'number' }),

  classTeacherRemark: text('class_teacher_remark').default('').notNull(),
  principalRemark: text('principal_remark').default('').notNull(),
  daysPresent: integer('days_present').default(0).notNull(),
  daysTotal: integer('days_total').default(0).notNull(),

  /** Snapshot of what the report said when it was issued. Not used to render a live report. */
  subjectsOffered: integer('subjects_offered').default(0).notNull(),
  totalScore: numeric('total_score', { precision: 10, scale: 2 }).default('0').notNull(),
  averageScore: numeric('average_score', { precision: 6, scale: 2 }).default('0').notNull(),
  classPosition: integer('class_position').default(0).notNull(),
  classSize: integer('class_size').default(0).notNull(),

  /** draft | submitted | approved | published. Mirrors the result workflow it was imported from. */
  status: varchar('status', { length: 20 }).default('draft').notNull(),
  submittedBy: bigint('submitted_by', { mode: 'number' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedBy: bigint('approved_by', { mode: 'number' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  slotUq: uniqueIndex('term_summaries_slot_uq').on(t.studentId, t.termId),
  schoolIdx: index('term_summaries_school_idx').on(t.schoolId, t.status),
}));

/**
 * The labelled parts of a theory question: (a) 2 marks, (b) 3 marks. The question keeps its own total.
 * Marking still awards one score per question, exactly as the plugin does; parts describe the question
 * and how its marks are split, so a printed paper and a marking guide can show them.
 */
export const questionParts = pgTable('question_parts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  questionId: bigint('question_id', { mode: 'number' }).notNull(),
  label: varchar('label', { length: 10 }).default('').notNull(),
  text: text('text').default('').notNull(),
  marks: numeric('marks', { precision: 8, scale: 2 }).default('0').notNull(),
  sequence: integer('sequence').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  questionIdx: index('question_parts_question_idx').on(t.questionId, t.sequence),
  schoolIdx: index('question_parts_school_idx').on(t.schoolId),
}));

/**
 * Remark wording that applies to the whole school for a role, by average band. staff_remark_ranges holds a
 * single teacher's own ranges; this is the school's shared set that a teacher without their own falls back to.
 */
export const schoolRemarkRanges = pgTable('school_remark_ranges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 }).notNull(),
  minAvg: numeric('min_avg', { precision: 5, scale: 2 }).default('0').notNull(),
  maxAvg: numeric('max_avg', { precision: 5, scale: 2 }).default('100').notNull(),
  remark: text('remark').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  roleIdx: index('school_remark_ranges_role_idx').on(t.schoolId, t.role, t.sortOrder),
}));
