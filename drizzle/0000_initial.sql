CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'inactive', 'pending_approval', 'transferred');--> statement-breakpoint
CREATE TYPE "public"."school_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('active', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('junior', 'senior', 'both');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('active', 'suspended', 'withdrawn', 'expelled', 'pending_approval', 'graduated');--> statement-breakpoint
CREATE TYPE "public"."subject_category" AS ENUM('core', 'elective');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('platform_admin', 'principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'disabled');--> statement-breakpoint
CREATE TABLE "academic_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"title" varchar(100) NOT NULL,
	"starts_on" timestamp with time zone,
	"ends_on" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_levels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"stage" "stage" DEFAULT 'junior' NOT NULL,
	"level_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"level_id" bigint NOT NULL,
	"department_id" bigint,
	"arm" varchar(20),
	"display_name" varchar(150) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"code" varchar(50) NOT NULL,
	"subdomain" varchar(63),
	"custom_domain" varchar(191),
	"logo_url" text,
	"address" text,
	"phone" varchar(50),
	"email" varchar(191),
	"website" varchar(191),
	"principal_name" varchar(191),
	"principal_photo_url" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "school_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"name" varchar(150) NOT NULL,
	"code" varchar(50) NOT NULL,
	"stage" "stage" DEFAULT 'both' NOT NULL,
	"category" "subject_category" DEFAULT 'elective' NOT NULL,
	"department_id" bigint,
	"is_compulsory" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"title" varchar(100) NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"starts_on" timestamp with time zone,
	"ends_on" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint,
	"actor_user_id" bigint,
	"actor_role" varchar(50),
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(100),
	"entity_id" bigint,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"status" "enrollment_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_student" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"guardian_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"relationship" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"user_id" bigint,
	"full_name" varchar(191) NOT NULL,
	"email" varchar(191),
	"phone" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(191) PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"user_id" bigint,
	"staff_number" varchar(50) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(191),
	"phone" varchar(50),
	"photo_url" text,
	"role" "user_role" NOT NULL,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_assignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"subject_id" bigint,
	"class_id" bigint,
	"assignment_type" varchar(30) DEFAULT 'subject_teacher' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_subjects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"user_id" bigint,
	"admission_number" varchar(50) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"middle_name" varchar(100),
	"gender" varchar(20),
	"date_of_birth" timestamp with time zone,
	"photo_url" text,
	"address" text,
	"parent_name" varchar(191),
	"parent_phone" varchar(50),
	"parent_email" varchar(191),
	"status" "student_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"admitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint,
	"role" "user_role" NOT NULL,
	"login_id" varchar(191) NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"failed_attempts" bigint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academic_sessions" ADD CONSTRAINT "academic_sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_levels" ADD CONSTRAINT "class_levels_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_level_id_class_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."class_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_student" ADD CONSTRAINT "guardian_student_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_student" ADD CONSTRAINT "guardian_student_guardian_id_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_student" ADD CONSTRAINT "guardian_student_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_school_title_uq" ON "academic_sessions" USING btree ("school_id","title");--> statement-breakpoint
CREATE INDEX "sessions_school_idx" ON "academic_sessions" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "levels_school_name_uq" ON "class_levels" USING btree ("school_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_scope_uq" ON "classes" USING btree ("school_id","level_id","department_id","arm");--> statement-breakpoint
CREATE INDEX "classes_school_idx" ON "classes" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_school_name_uq" ON "departments" USING btree ("school_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_code_uq" ON "schools" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_subdomain_uq" ON "schools" USING btree ("subdomain");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_custom_domain_uq" ON "schools" USING btree ("custom_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_school_code_uq" ON "subjects" USING btree ("school_id","code");--> statement-breakpoint
CREATE INDEX "subjects_school_idx" ON "subjects" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_session_position_uq" ON "terms" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "terms_school_idx" ON "terms" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "audit_school_idx" ON "audit_log" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_student_session_uq" ON "enrollments" USING btree ("student_id","session_id");--> statement-breakpoint
CREATE INDEX "enrollments_class_idx" ON "enrollments" USING btree ("class_id","status");--> statement-breakpoint
CREATE INDEX "enrollments_school_idx" ON "enrollments" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_student_uq" ON "guardian_student" USING btree ("guardian_id","student_id");--> statement-breakpoint
CREATE INDEX "guardians_school_idx" ON "guardians" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_school_number_uq" ON "staff" USING btree ("school_id","staff_number");--> statement-breakpoint
CREATE INDEX "staff_school_idx" ON "staff" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_assignment_uq" ON "staff_assignments" USING btree ("staff_id","subject_id","class_id","assignment_type");--> statement-breakpoint
CREATE INDEX "staff_assignments_school_idx" ON "staff_assignments" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_subjects_uq" ON "student_subjects" USING btree ("student_id","subject_id","session_id");--> statement-breakpoint
CREATE INDEX "student_subjects_school_idx" ON "student_subjects" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "students_school_admission_uq" ON "students" USING btree ("school_id","admission_number");--> statement-breakpoint
CREATE INDEX "students_school_idx" ON "students" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "students_status_idx" ON "students" USING btree ("school_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_school_login_uq" ON "users" USING btree ("school_id","login_id");--> statement-breakpoint
CREATE INDEX "users_school_idx" ON "users" USING btree ("school_id");