-- Short ID prefix used on every student/staff number a school issues
-- (KC/26/0412, KC/SF/0018) — separate from the long, human-chosen `code`.
-- Nullable + backfilled: existing schools get theirs set by a one-off
-- backfill script (see scripts/backfill-id-prefix.ts), not by this
-- migration, because the value is derived from each school's NAME, which
-- SQL alone should not be computing collision-safe abbreviations for.
ALTER TABLE schools ADD COLUMN id_prefix varchar(10);
--> statement-breakpoint
CREATE UNIQUE INDEX schools_id_prefix_uq ON schools (id_prefix);
