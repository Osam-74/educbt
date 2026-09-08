# CA score entry

Route: `/portal/ca`. Navigation integration is deliberately deferred: this change does not touch global navigation, layouts, platform routes, global CSS, package manifests, or migrations.

## Workflow

Select an authorized class/subject pair, session/term, and CA component. The roster includes only active students with active enrollment and subject registration in that session. Each row saves independently and shows success/failure. Blank input is not converted to zero; zero and scores with up to two decimal places are supported. There is no bulk import, deletion, automatic compilation, or result publication here.

## Components

The schema already stores school settings and defines `AssessmentComponent`, but main has no component-settings reader or editor. This feature reads `schools.settings.assessmentComponents` using that domain shape. The school's academic setup must provide an array such as:

```json
[
  { "key": "ca1", "label": "First CA", "maxScore": 20, "isExam": false },
  { "key": "ca2", "label": "Second CA", "maxScore": 10, "isExam": false },
  { "key": "exam", "label": "Examination", "maxScore": 70, "isExam": true }
]
```

These values are an example, not a default or a prescribed grading policy. Only non-exam components are offered. Missing/invalid configuration disables entry with setup guidance. Configuration is re-read when saving, including the maximum. This branch does not configure any production school. A school-settings editor and its navigation remain follow-ups.

## Service and security

- Reuses `requireSchoolSession`, `forSchool`, `enterScore`, and domain `isEditable`.
- School identity comes from the session, never the form.
- Teachers require an active staff record linked to the session user and an active `subject_teacher` assignment matching BOTH class and subject. Null/general class-teacher assignments do not grant score access.
- Principal, vice principal and exam officer retain the existing school-wide role convention.
- Student, parent, platform admin and unknown roles are denied.
- Read selectors and saves independently validate tenant, calendar relationship, assignment, active enrollment and subject registration.
- All feature database access uses the runtime app role and `forSchool`; RLS is unchanged.
- Score reads/upserts retain exactly school, student, subject, session, term and component. Class is a validated enrollment constraint, not part of the score identity.
- Reviewed, published and locked results (and inconsistent published flags) refuse entry. Only draft/compiled or absent results allow it.
- A saved score makes a compiled result draft/incomplete, requiring recompilation before review.
- Score entry, compilation and lifecycle transition acquire a transaction-scoped advisory lock per school/session/term. This prevents a save racing publication, including when there is no result row yet.
- Existing `enteredBy` and `updatedAt` record who last saved the score. No claim of a new immutable per-edit audit history.

## Tests

```text
npx tsx src/lib/ca/validation.test.ts
npx tsx src/db/test-ca.ts
```

The first has 20 checks and requires no database. Integration tests require `DATABASE_URL_APP` and `DATABASE_URL_UNPOOLED` pointing at a disposable LOCAL database whose name ends in `_ca_test`. Prepare migrations/RLS and the non-owner, non-BYPASSRLS app role first.

Integration creates UUID-named schools and deletes only its fixtures in finally, including non-cascading score/result/audit rows. It does not depend on DEMO fixtures. 59 service/RLS/concurrency checks; optional `CA_TEST_HTTP_URL=http://127.0.0.1:3017` adds five real HTTP route checks against a running app using the same disposable DB. The HTTP checks verify authentication redirect, rendered context, read-only state, forged-scope rejection and configuration guidance. They are not a visual or interactive browser test.

## Review and integration

The only existing feature file changed is `src/lib/exam/results.ts`; the other files are confined to CA and its tests/docs. Keep the six-column conflict target and shared term lock if another results change touches that file.

Before release: configure each school's actual assessment components, finish visual/interactive browser QA, and integrate a role-appropriate navigation link after coordinating ownership. Existing Windows baseline failures in configuration-path scanning and local backup directory handling are unrelated and remain unchanged. The print suite also needs native Pango/GLib libraries on Windows. Re-run those suites in the project's Linux/CI environment before treating the entire baseline as green.
