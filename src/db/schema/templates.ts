import { pgTable, bigint, varchar, timestamp } from 'drizzle-orm/pg-core';
import { schools } from './core';

/** One row per school that has an explicit assignment. NULL column = inherit the platform default. */
export const schoolDocumentTemplates = pgTable('school_document_templates', {
  schoolId: bigint('school_id', { mode: 'number' }).primaryKey().references(() => schools.id, { onDelete: 'cascade' }),
  reportTemplate: varchar('report_template', { length: 40 }),
  transcriptTemplate: varchar('transcript_template', { length: 40 }),
  broadsheetTemplate: varchar('broadsheet_template', { length: 40 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
