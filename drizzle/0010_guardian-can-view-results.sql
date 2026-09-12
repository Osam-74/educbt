-- Only the guardian_student.can_view_results column is added here.
-- The sitting_opens_at / sitting_closes_at columns that drizzle-kit also
-- diffed are ALREADY applied by 0009_sitting_window.sql (whose snapshot was
-- never committed on main, so the 0008 snapshot was the diff base). This
-- migration is hand-trimmed before its first commit for exactly that reason.
ALTER TABLE "guardian_student" ADD COLUMN "can_view_results" boolean DEFAULT true NOT NULL;
