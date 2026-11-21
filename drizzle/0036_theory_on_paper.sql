-- Theory answered on paper (WordPress plugin parity). ADDITIVE ONLY: two defaulted boolean columns. Nothing is altered
-- or dropped, and every existing set and paper keeps behaving exactly as it does now (theory typed on screen).
ALTER TABLE "question_sets" ADD COLUMN "theory_on_paper" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "exam_papers" ADD COLUMN "theory_on_paper" boolean DEFAULT false NOT NULL;
