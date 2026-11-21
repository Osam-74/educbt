# Question Bank completion

Initial base: `3426e51f032148e919010fcf6b8fac7d0ef8398b`. Updated cleanly to `e4eeebcf0f4bb0d157fb3d13429ef4a38eb91a81`, preserving the later TOTP, email drain and candidate theory-answer work.

## School Settings reconciliation

The old `a11a6a3` School Settings branch is superseded, not to be merged or pushed to main. All substantive work is present: settings screens/actions, profile and academic services, validation, ranking, immutable grading versions, raster uploads, signatures, automatic/manual remarks, configuration locks and forced tenant RLS. Report rendering still consumes the stored data. Main improves explicit school filtering of report staff/signatures and adds cascade cleanup. `0016_school_settings.sql` follows promotion `0014` and communications `0015`. No reconciliation code or repeated full baseline is required.

## Legacy reference before implementation

Commit `0864e950a161f1bc2ffdb1744a35694fcebf3c90` of `Osam-74/cbt`.
Inspected `includes/Services/QuestionWindowService.php`, `QuestionApprovalService.php`, `QuestionSetService.php`, `QuestionAuthoringService.php`, `WaecBlueprintService.php` and `templates/portal/exams/questions.php`.

Legacy has one office-selected formal collection window, independent practice access, configurable objective/theory quotas (defaults 20/4), progress, review and reasoned return. Next.js already has series submission dates, set minima, exact scope identities, approval and composition. Missing enforcement and entry controls will reuse those structures. Terminal examinations retain series-zero set identity for compatibility with existing composition; the selected formal series supplies the session/term window. New quota values apply to new sets, preserving existing set requirements.

The English-specific legacy WAEC blueprint includes three papers, section counts/marks, passages and candidate choice. Existing Next.js composition is objective-only and does not implement the complete choice/grouping contract. This is a documented gap; this block must not present generic composition as full WAEC parity. No external AI service is introduced.

Initial confirmed defects: absent submission ownership check; paired sibling lookup omits department; service validation allows multiple correct answers in single-choice items; creation lacks assigned-scope validation. Changes remain in Question Bank and its focused tests.

## Update 2026-11-21: theory delivery

The "objective-only" statement above is no longer true for a school's own examination. `composeSeries` now attaches the approved theory questions of the paired theory set (same subject, level, department, terminal bank, same WAEC kind) after the objective pool. Each candidate sits the objective draw (the paper's question count, unchanged) followed by ALL the theory, in authored order (`src/lib/exam/theory-delivery.ts`). At submit every theory question gets an unmarked answer row, so the teacher's marking queue lists it and the result stays incomplete until it is marked. CA tests, practice papers and WAEC sets never carry theory. WAEC choice/grouping across sections is still not implemented.

## Update 2026-11-21: theory on paper

A theory set can be marked "answered on paper" (`question_sets.theory_on_paper`, theory sets only, changeable only while the set is with its teacher; migration 0036, default false, additive). `composeSeries` sets `exam_papers.theory_on_paper` only when EVERY attached theory question comes from such a set (`paperIsOnPaper`; a paper with no theory is never on paper). On such a paper the student reads the theory on screen with no answer box, the server refuses typed theory (`saveAnswer` returns `on_paper`, API 409), objective answers are unaffected, and submit still creates one unmarked row per theory question so the teacher can enter the mark. Difference from the plugin: the plugin enters one mark per sub-part; the SaaS enters one mark per theory question (its maximum already equals the sum of its parts). One theory set exists per scope in the SaaS, so the plugin's "mixed sets on one paper" case cannot arise; the all-or-nothing rule is still enforced and unit-tested.

## Implementation checkpoint (not yet accepted)

Implemented office collection selection/closing, quota configuration for new sets, assigned-scope start/continue controls, active-account checks, teacher ownership/assignment checks, school-scoped entity validation, date-window enforcement, exact department pairing, single-answer/marks/duplicate validation, review transition restrictions and audit entries. A returned half may be resubmitted without altering its approved partner. School settings storage is reused through a single JSON key, with the existing configuration lock; no migration or document CSS changes.

Focused validation: 27 checks passed. Application-role service/browser verification: 28 checks passed (22 service, 6 browser), including expired windows, revoked assignments, ownership, tenant RLS, lifecycle, audit, collection save, invalid type/collection feedback and successful start-set routing. Typecheck and the production build passed after the latest main integration. Desktop 1440px, mobile 390px and validation-error screenshots were generated and inspected in `baseline-logs/question-bank-*.png`.

The CI workflow now includes the current repository's promotion, communications, operational, role and TOTP suites as well as the new Question Bank checks. Full Linux CI remains the merge gate; no duplicate old 955-check local baseline was run. Quotas apply to new sets, leaving existing set requirements unchanged. Full legacy WAEC section/choice composition remains a documented gap rather than an unsupported compliance claim.
