/**
 * Vault storage.
 *
 * The table lives here so drizzle-kit can discover it; the logic that reads and
 * writes it lives in src/lib/exam/vault.ts alongside the rest of the exam code.
 */

import {
  pgTable, bigserial, bigint, timestamp, jsonb, integer, index,
} from 'drizzle-orm/pg-core';
import { schools } from './core';

export const questionVault = pgTable('question_vault', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull()
    .references(() => schools.id, { onDelete: 'cascade' }),
  questionSetId: bigint('question_set_id', { mode: 'number' }).notNull(),

  // The whole set, including options and their correctness. This table is not
  // served to candidates and must never be joined into a paper query.
  payload: jsonb('payload').notNull(),

  questionCount: integer('question_count').default(0).notNull(),
  takenAt: timestamp('taken_at', { withTimezone: true }).defaultNow().notNull(),
  reason: jsonb('reason').$type<{ trigger: string }>(),
}, (t) => ({
  setIdx: index('vault_set_idx').on(t.schoolId, t.questionSetId, t.takenAt),
}));
