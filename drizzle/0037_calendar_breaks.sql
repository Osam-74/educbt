-- Two more kinds of day off for the academic calendar (WordPress plugin parity): a mid-term break and a general
-- non-instructional day. ADDITIVE ONLY: two new enum values. No existing row, column or value is touched.
ALTER TYPE "public"."calendar_category" ADD VALUE IF NOT EXISTS 'mid_term_break';
--> statement-breakpoint
ALTER TYPE "public"."calendar_category" ADD VALUE IF NOT EXISTS 'non_instructional';
