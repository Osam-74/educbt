-- Plugin parity: the names people used to sign in with on the WordPress plugin keep working.
-- The plugin let a student sign in with an admission number, a registration number or a username, and staff with a
-- WordPress login such as DSS001.STF.007. The platform's own sign-in names are shaped differently (dss001/stf/007), so
-- each person's old names are kept as ALIASES. The main users.login_id is not touched.
-- An alias only ever finds a person inside ONE school (school_id is part of the key and of row-level security), and a
-- real sign-in name always wins over an alias at sign-in, so an alias can never open someone else's account.
-- ADDITIVE ONLY: a new table and indexes, nothing altered or dropped.
CREATE TABLE "user_login_aliases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"alias" varchar(191) NOT NULL,
	"source" varchar(40) DEFAULT 'wordpress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_login_aliases" ADD CONSTRAINT "user_login_aliases_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_login_aliases" ADD CONSTRAINT "user_login_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_login_aliases_school_alias_uq" ON "user_login_aliases" USING btree ("school_id",lower("alias"));
--> statement-breakpoint
CREATE INDEX "user_login_aliases_user_idx" ON "user_login_aliases" USING btree ("user_id");
