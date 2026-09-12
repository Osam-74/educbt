-- Legacy staff carried a title (Mr / Mrs / Dr) and sex on the record; the
-- staff table and both legacy forms (add + edit) show them. Ported as plain
-- varchar columns (legacy stored free text) with no behavior attached.
ALTER TABLE "staff" ADD COLUMN "title" varchar(50);
ALTER TABLE "staff" ADD COLUMN "gender" varchar(20);
