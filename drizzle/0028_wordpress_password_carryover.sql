-- Passwords from the WordPress plugin cross over, and the person is offered (never forced) a new one.
-- ADDITIVE ONLY: two nullable columns, nothing altered or dropped, so applying this changes no existing row
-- and no existing sign-in. NULL means "an ordinary account": no prompt, exactly as before.
--   password_carried_at          set when a school arrives from the plugin carrying this person's old password
--                                hash; cleared as soon as it is replaced by an Argon2id hash at their first
--                                successful sign-in.
--   password_prompt_dismissed_at set when the person chooses to keep their password after being offered a new one.
ALTER TABLE "users" ADD COLUMN "password_carried_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_prompt_dismissed_at" timestamp with time zone;
