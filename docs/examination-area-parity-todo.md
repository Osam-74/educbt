# Exam Papers page — plugin parity, section by section

Source of truth: the owner's screenshot of the legacy plugin's Exam Papers
page (`templates/portal/exams/papers.php`), plus the owner's own written
walkthrough (2026-09-16) explaining what each section is *for*, not just
what it looks like. Read this before touching the page again — a purely
visual pass will repeat the same mistake (see "already done" below).

The page is ONE scrollable page with these sections, top to bottom:

## 1. Practice exam notice
A notice/toggle: practice papers are available for teachers to set
questions into *at any time*, and are automatically available to students
to take — nothing here is scheduled or reviewed like a CA test or
examination. Needs: whatever backend state currently represents "practice"
series (likely already exists as `seriesType: 'practice'` per
`src/lib/exam/compose.ts`) surfaced here as its own small panel, not folded
into the general list.

## 2. Question bank controller
**Not** the Question Bank nav page itself — this is the *admin control* for
it. Teachers submit CA/exam questions into a school-wide question bank, but
that bank must not be open for setting at all times. This section is where
the office chooses which collection (e.g. "First CA Test", "Examination")
is *currently open* for teachers to set questions against. When a teacher
opens their Question Bank page, they can only choose from whichever
type this control has made open. Needs: a persisted "currently open
collection" setting (per school, likely per term) + an "Apply" action, and
the Question Bank teacher-facing page must read and enforce it.

## 3. Continuous assessment tests table
Shows every **active** CA assessment with: assessment name, questions
required per student, papers submitted count, total papers, status, and
row actions — **Compose** and **Build timetable**. This is a live status
table, not a form. Backend likely needs a query joining CA series with
per-subject submission counts — check `src/lib/exam/compose.ts` /
`dashboard.ts` for anything reusable before writing a new one.

## 4. Open a new assessment window (CA)
A form with six fields, matching options configured in School Settings:
- **Counts towards** (which CA slot — First CA, Second CA, Assignment, etc.
  — these come from school settings, not hardcoded)
- **Name** (optional — defaults from the slot if left blank)
- **Question window opens** / **Question window closes** (dates teachers
  can submit questions)
- **Questions per student**
- **Duration (minutes)**
Submit button: **"Open assessment window"**. This is functionally close to
what `createSeries()` already does for examinations — check whether it can
take a `ca_test` seriesType with a slot reference, or whether a new
`openAssessmentWindow()` action is needed.

## 5. Create examination
**Already done** (commit `c43b06a`, 2026-09-16) — moved inline from the old
`/portal/exams/new` route, same `createSeries()` action, fields: Name,
Type, Session, Term, Questions per paper, Duration, optional question
window dates. Do not redo this — just confirm it still matches once the
sections above/below exist around it.

## 6. Examinations table
Every created examination (CA test, terminal examination, or practice),
with: Session/Term, Q-Bank open/close dates, Status, and row actions —
**Build timetable**, **Publish**, **Delete**. Similar in shape to the
"All examinations" table already on the page, but needs the Build
timetable / Publish / Delete actions added — currently only has an "Open"
link.

## 7. Submitted papers — pending review
This is **not** the same as the Examinations table. Whenever a teacher
submits questions from their Question Bank, this section is where the
school office reviews them: **Subject**, **Class**, **Type** (CA test or
examination), **date submitted**, **number of questions in the pool**, and
review/approve actions. This may already exist as `/portal/exams/approvals`
("Approve Questions") — check whether that page's data can be surfaced here
too, or whether this is meant to be a distinct submitted-papers queue.

---

## Process reminder (standing instructions from the owner)
- Commit and push directly to `main`, no branches/PRs.
- Do not touch the 8-item Examination nav order.
- Reuse `sd-panel` / `tbl` / `eo-` classes already established in
  `src/app/portal/portal-shell.css` — do not invent new table styling.
- Verify against a seeded local fixture + typecheck + build + targeted
  tests before every push; full E2E at batch/merge/prod checkpoints.
- Ignore the pre-existing `test-result-workflow.ts` "foreign academic
  scope denied" failure unless you touch that code path — confirmed
  failing identically on a clean `main`, unrelated to Examinations.
- Push **one section/page at a time**, not as one giant commit — the owner
  wants to review incrementally.

## Do this same section-by-section treatment for the other 3 pages
The owner's core complaint is general, not just about this page: sections
must reflect *why* they exist in the plugin (their real function), not
just be restyled panels. Before rebuilding Timetable, Invigilation
Schedule, or Marking Status, get (or re-derive from existing plugin
screenshots already shared in this conversation's history) the same kind
of section-by-section functional breakdown before writing code.
