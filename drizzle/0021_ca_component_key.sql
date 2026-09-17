-- The "component_id" bigint column was added for "which assessment column a
-- CA test's marks land in" but was never wired to anything: assessment
-- components are string-keyed JSON on schools.settings.assessmentComponents
-- (key/label/maxScore/isExam), never a numeric-id table. No code ever read
-- or wrote this column, so dropping it loses no data.
ALTER TABLE "exam_series" DROP COLUMN "component_id";
--> statement-breakpoint
ALTER TABLE "exam_series" ADD COLUMN "ca_component_key" varchar(64);
