import { pgTable, bigserial, bigint, varchar, text, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { schools } from './core';
import { staff } from './people';
import type { GradingScale } from '@/domain/academic';

export const gradingScaleVersions = pgTable('grading_scale_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id),
  scaleId: varchar('scale_id', { length: 50 }).notNull(), version: integer('version').notNull(),
  snapshot: jsonb('snapshot').$type<GradingScale>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('grading_scale_versions_uq').on(t.schoolId, t.scaleId, t.version) }));

export const staffSignatures = pgTable('staff_signatures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id),
  role: varchar('role', { length: 30 }).notNull(), name: varchar('name', { length: 191 }).notNull(),
  type: varchar('type', { length: 10 }).notNull(), data: text('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('staff_signatures_uq').on(t.schoolId, t.staffId, t.role) }));

export const staffRemarkRanges = pgTable('staff_remark_ranges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id),
  role: varchar('role', { length: 30 }).notNull(),
  ranges: jsonb('ranges').$type<Array<{ min: number; remark: string }>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('staff_remark_ranges_uq').on(t.schoolId, t.staffId, t.role) }));

export const reportRemarks = pgTable('report_remarks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id),
  studentId: bigint('student_id', { mode: 'number' }).notNull(),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(), termId: bigint('term_id', { mode: 'number' }).notNull(),
  staffId: bigint('staff_id', { mode: 'number' }).notNull().references(() => staff.id),
  role: varchar('role', { length: 30 }).notNull(), source: varchar('source', { length: 10 }).notNull(), remark: text('remark').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({ uq: uniqueIndex('report_remarks_uq').on(t.schoolId, t.studentId, t.sessionId, t.termId, t.role) }));
