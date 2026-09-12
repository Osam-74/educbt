-- Exam timetable + invigilation parity (legacy EduCBT Pro).
--
-- Scheduling, venue and access-code handling all live on exam_papers, matching
-- the legacy columns papers.closes_at / papers.venue / papers.requires_access_code /
-- papers.access_code. Invigilators were already carried on papers
-- (invigilator_staff_id, one per paper — the legacy paper_invigilators table
-- existed only to allow several; a paper is invigilated by one member of staff).
--
-- attempts.submit_reason records why an attempt closed, so a forced submission
-- by an invigilator is never indistinguishable from a student pressing Submit.

ALTER TABLE "exam_papers" ADD COLUMN "closes_at" timestamptz;
ALTER TABLE "exam_papers" ADD COLUMN "venue" varchar(191);
ALTER TABLE "exam_papers" ADD COLUMN "requires_access_code" boolean DEFAULT false NOT NULL;
ALTER TABLE "exam_papers" ADD COLUMN "access_code" varchar(16);
ALTER TABLE "exam_papers" ADD COLUMN "code_released_at" timestamptz;
ALTER TABLE "exam_papers" ADD COLUMN "code_released_by" bigint;

ALTER TABLE "attempts" ADD COLUMN "submit_reason" varchar(100);

-- The invigilation clash check asks "who is already in a hall between these
-- times?" for every paper in a series, so the window is indexed.
CREATE INDEX "papers_scheduled_idx" ON "exam_papers" ("school_id", "series_id", "scheduled_at");
