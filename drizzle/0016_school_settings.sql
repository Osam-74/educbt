CREATE TABLE grading_scale_versions (
 id bigserial PRIMARY KEY, school_id bigint NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 scale_id varchar(50) NOT NULL, version integer NOT NULL CHECK(version > 0),
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT grading_scale_versions_uq UNIQUE(school_id, scale_id, version)
);
--> statement-breakpoint
ALTER TABLE staff ADD CONSTRAINT staff_id_school_uq UNIQUE(id, school_id);
--> statement-breakpoint
CREATE TABLE staff_signatures (
 id bigserial PRIMARY KEY, school_id bigint NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 staff_id bigint NOT NULL, role varchar(30) NOT NULL CHECK(role IN ('principal','class_teacher','exam_officer')),
 name varchar(191) NOT NULL, type varchar(10) NOT NULL CHECK(type IN ('text','upload')),
 data text NOT NULL CHECK(octet_length(data) <= 400000),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(staff_id,school_id) REFERENCES staff(id,school_id) ON DELETE CASCADE,
 CONSTRAINT staff_signatures_uq UNIQUE(school_id,staff_id,role)
);
--> statement-breakpoint
CREATE TABLE staff_remark_ranges (
 id bigserial PRIMARY KEY, school_id bigint NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 staff_id bigint NOT NULL, role varchar(30) NOT NULL CHECK(role IN ('principal','class_teacher')),
 ranges jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(staff_id,school_id) REFERENCES staff(id,school_id) ON DELETE CASCADE,
 CONSTRAINT staff_remark_ranges_uq UNIQUE(school_id,staff_id,role)
);
--> statement-breakpoint
CREATE TABLE report_remarks (
 id bigserial PRIMARY KEY, school_id bigint NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 student_id bigint NOT NULL REFERENCES students(id) ON DELETE CASCADE, session_id bigint NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
 term_id bigint NOT NULL REFERENCES terms(id) ON DELETE CASCADE, staff_id bigint NOT NULL,
 role varchar(30) NOT NULL CHECK(role IN ('principal','class_teacher')),
 source varchar(10) NOT NULL CHECK(source IN ('manual','automatic')), remark text NOT NULL CHECK(length(remark) <= 500),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(staff_id,school_id) REFERENCES staff(id,school_id) ON DELETE CASCADE,
 CONSTRAINT report_remarks_uq UNIQUE(school_id,student_id,session_id,term_id,role)
);
