CREATE TABLE "question_vault" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_set_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" jsonb
);
--> statement-breakpoint
ALTER TABLE "question_vault" ADD CONSTRAINT "question_vault_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_set_idx" ON "question_vault" USING btree ("school_id","question_set_id","taken_at");