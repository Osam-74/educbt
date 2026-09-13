/**
 * Promotion and transcripts (legacy EduCBT Pro parity — Phase 8).
 *
 * PROMOTION is a rule-driven batch with human review. The proposal is stored,
 * never applied: nothing moves until the principal commits, and the decision
 * for every student — proposed and final, with the reason for every override —
 * is kept, so "why was my child not promoted" has an answer on file.
 *
 * Promotion never overwrites history. Commit writes NEXT session's enrollments
 * only; the from-session enrollment and every result row stay exactly as they
 * were, so a student's record of what they sat, where and when is permanent.
 *
 * TRANSCRIPTS are issued documents, not a live view. Every copy that leaves
 * the school is recorded against a serial; reissues and revocations are
 * tracked so a disputed document can be traced to who issued it, when and why.
 * Verification uses a server-side HMAC over the serial — the printed document
 * carries the serial and its code, the school's secret never leaves the
 * server, and nobody can enumerate or forge a code for a serial they don't
 * hold. (The legacy checksum was salted with wp_salt and verifiable only by
 * staff with database access — this replaces it.)
 */

import {
  pgTable, bigserial, bigint, varchar, integer, numeric, timestamp,
  uniqueIndex, index, pgEnum, jsonb,
} from 'drizzle-orm/pg-core';

/** Three outcomes rather than two. "Promote on trial" is real practice in
 *  Nigerian schools; a system offering only promote/repeat forces a principal
 *  to lie in one direction or the other. `unresolved` means no published
 *  results — no defensible decision, flagged rather than guessed. */
export const promotionOutcome = pgEnum('promotion_outcome', [
  'promote', 'trial', 'repeat', 'graduate', 'unresolved',
]);

export const promotionStatus = pgEnum('promotion_status', [
  'proposed', 'committed', 'reversed',
]);

export const promotionBatches = pgTable('promotion_batches', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  fromSessionId: bigint('from_session_id', { mode: 'number' }).notNull(),
  toSessionId: bigint('to_session_id', { mode: 'number' }).notNull(),
  levelId: bigint('level_id', { mode: 'number' }).notNull(),

  /** The ruleset snapshot that produced these decisions. A later rules change
   *  must not make an old batch unexplainable. */
  rules: jsonb('rules').$type<Record<string, unknown>>(),

  totalEvaluated: integer('total_evaluated').default(0).notNull(),
  totalPromoted: integer('total_promoted').default(0).notNull(),
  totalTrial: integer('total_trial').default(0).notNull(),
  totalRepeated: integer('total_repeated').default(0).notNull(),
  totalGraduated: integer('total_graduated').default(0).notNull(),
  totalUnresolved: integer('total_unresolved').default(0).notNull(),

  status: promotionStatus('status').default('proposed').notNull(),

  createdBy: bigint('created_by', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  committedBy: bigint('committed_by', { mode: 'number' }),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  reversedBy: bigint('reversed_by', { mode: 'number' }),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
}, (t) => ({
  scopeIdx: index('promotion_batches_scope_idx').on(t.schoolId, t.status),
  fromIdx: index('promotion_batches_from_idx').on(t.schoolId, t.fromSessionId, t.levelId),
}));

export const promotionDecisions = pgTable('promotion_decisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  studentId: bigint('student_id', { mode: 'number' }).notNull(),
  fromClassId: bigint('from_class_id', { mode: 'number' }),
  toClassId: bigint('to_class_id', { mode: 'number' }),

  proposedOutcome: promotionOutcome('proposed_outcome').default('promote').notNull(),
  finalOutcome: promotionOutcome('final_outcome').default('promote').notNull(),

  averageScore: numeric('average_score', { precision: 6, scale: 2 }).default('0').notNull(),
  subjectsPassed: integer('subjects_passed').default(0).notNull(),
  /** How many subjects the student actually offers — the pass threshold is
   *  capped at this, so a 5-subject student is not judged against "pass 6". */
  subjectsOffered: integer('subjects_offered').default(0).notNull(),

  /** The rule engine's note: 'no_published_results', 'failed_compulsory_subject'. */
  note: varchar('note', { length: 100 }).default('').notNull(),

  overrideReason: varchar('override_reason', { length: 255 }).default('').notNull(),
  overriddenBy: bigint('overridden_by', { mode: 'number' }),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  batchStudentUq: uniqueIndex('promotion_decisions_batch_student_uq').on(t.batchId, t.studentId),
  studentIdx: index('promotion_decisions_student_idx').on(t.studentId),
  schoolIdx: index('promotion_decisions_school_idx').on(t.schoolId),
}));

export const transcriptStatus = pgEnum('transcript_status', [
  'issued', 'reissued', 'revoked',
]);

export const transcripts = pgTable('transcripts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  studentId: bigint('student_id', { mode: 'number' }).notNull(),

  /** GRE001/TR/2026/0007 — school, document type, year, sequence. */
  serial: varchar('serial', { length: 60 }).notNull(),
  purpose: varchar('purpose', { length: 255 }).default('').notNull(),

  /** Snapshot of what was transcribed, so a later verification can say whether
   *  the school's live data has moved on since the copy left the building. */
  termsRecorded: integer('terms_recorded').default(0).notNull(),
  cumulativeAverage: numeric('cumulative_average', { precision: 6, scale: 2 }).default('0').notNull(),

  issuedBy: bigint('issued_by', { mode: 'number' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  status: transcriptStatus('status').default('issued').notNull(),

  revokeReason: varchar('revoke_reason', { length: 255 }).default('').notNull(),
  revokedBy: bigint('revoked_by', { mode: 'number' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  serialUq: uniqueIndex('transcripts_serial_uq').on(t.serial),
  schoolStudentIdx: index('transcripts_school_student_idx').on(t.schoolId, t.studentId),
  issuedIdx: index('transcripts_issued_idx').on(t.schoolId, t.status),
}));
