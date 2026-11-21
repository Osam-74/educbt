-- Theory choice (WordPress plugin parity): the teacher decides how many theory questions each student answers, and which
-- questions every student must get. ADDITIVE ONLY: three defaulted columns. Nothing is altered or dropped, and every
-- existing question, set and paper behaves exactly as before (0 = every student answers every theory question).
ALTER TABLE "questions" ADD COLUMN "is_compulsory" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_sets" ADD COLUMN "theory_answer_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "exam_papers" ADD COLUMN "theory_answer_count" integer DEFAULT 0 NOT NULL;
