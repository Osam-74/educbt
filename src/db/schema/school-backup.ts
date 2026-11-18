/**
 * Platform-level state for restoring a school from an uploaded backup.
 *
 * These tables have NO school_id: the school being restored does not exist yet. They are
 * platform-admin-only (see rls.sql). A chunk is a slice of a whole school's data, so unlike
 * platform_settings there is no public read.
 *
 * The job row holds status and progress only. It never holds a password: the restore runs with
 * principalPassword 'defer', and the operator issues one afterwards.
 */
import {
  pgTable, bigserial, bigint, integer, text, varchar, timestamp, customType, index, uniqueIndex, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const backupJobStatus = pgEnum('backup_job_status', ['uploading', 'queued', 'restoring', 'succeeded', 'failed', 'cancelled']);

export const schoolBackupJobs = pgTable('school_backup_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  status: backupJobStatus('status').default('uploading').notNull(),
  fileName: varchar('file_name', { length: 200 }).notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  totalChunks: integer('total_chunks').notNull(),
  /** sha256 of the whole uploaded file, supplied by the browser, verified after reassembly */
  sha256: varchar('sha256', { length: 64 }).notNull(),
  newSchoolCode: varchar('new_school_code', { length: 64 }).notNull(),
  newSchoolSubdomain: varchar('new_school_subdomain', { length: 64 }),
  newSchoolName: varchar('new_school_name', { length: 200 }),
  restoredSchoolId: bigint('restored_school_id', { mode: 'number' }),
  /** a short, plain-English reason when status is failed; never data */
  errorMessage: text('error_message'),
  /** row counts of the restored school, on success */
  summary: jsonb('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('school_backup_jobs_status_idx').on(t.status, t.createdAt),
}));

export const schoolBackupChunks = pgTable('school_backup_chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jobId: bigint('job_id', { mode: 'number' }).notNull().references(() => schoolBackupJobs.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  data: bytea('data').notNull(),
  byteSize: integer('byte_size').notNull(),
}, (t) => ({
  jobPositionUq: uniqueIndex('school_backup_chunks_job_pos_uq').on(t.jobId, t.position),
}));
