-- Comprehension passage parity with the WordPress plugin. ADDITIVE ONLY: three nullable/defaulted columns and one index.
-- Nothing is altered or dropped; every existing passage and question keeps its current behaviour.
ALTER TABLE "passages" ADD COLUMN "instructions" text;
--> statement-breakpoint
ALTER TABLE "passages" ADD COLUMN "class_level" varchar(50) DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "passage_position" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "questions_passage_idx" ON "questions" USING btree ("passage_id","passage_position");
