-- Assessment mode toggle for both CA tests and examinations (exam_series
-- covers both, distinguished by series_type): 'cbt', 'written', or 'mixed'
-- (subject teachers choose per subject, and a written declaration under
-- 'mixed' requires exam-office review rather than auto-clearing). See
-- src/lib/exam/sets.ts submitSet() and src/db/schema/questions.ts.
CREATE TYPE "public"."assessment_mode" AS ENUM ('cbt', 'written', 'mixed');
ALTER TABLE "exam_series" ADD COLUMN "assessment_mode" "public"."assessment_mode" DEFAULT 'mixed' NOT NULL;
