# Results migration: reference and gaps

Reference: Osam-74/cbt at `0864e950a161f1bc2ffdb1744a35694fcebf3c90`, inspected before implementation.

## Reference files

- `templates/portal/school/results.php`: class table, stages, enrollment/compiled distinction, compile/recompile, review, publication and broadsheet actions.
- `templates/portal/school/review.php`: student and subject component grid; legacy inline moderation.
- `includes/Services/ResultCompilationService.php`: subject offerings, competition ranking, average-based class summary and readiness.
- `includes/Services/ResultWorkflowService.php`, `ResultApprovalService.php`, `includes/Core/Capabilities.php`: ordered transitions, privileged reversals and role grants. These legacy implementations differ: the capability hierarchy reserves approval/publication/unlock to principal, while the separate approval service grants some approval to vice principal. Use the stricter capability hierarchy for the new final review sign-off.
- `includes/Services/GradingService.php`, `GradeComputationService.php`: configurable grade bands; components sum to 100 with exactly one exam component.
- `includes/Services/ReportCardDocument.php`, `DocumentBrandingService.php`, `SignatureService.php`, `RemarkService.php`: school crest centered above letterhead, crest background plus school-name watermark, named class-teacher/principal signatures, manual/automatic remarks, grading legend and verification QR.
- `templates/portal/teacher/report.php`, `templates/portal/school/broadsheet.php`, `templates/portal/exams/broadsheet.php`, `includes/Services/BroadsheetService.php`, `assets/css/educbt-print.css`, `assets/css/educbt-portal.css`: report access, grids, repeated print headers, portrait cards/landscape broadsheets, green portal branding and compact cards/tables.

## Decisions recorded before implementation

- Preserve class-scoped operations, session/term context, enrolled-versus-compiled distinction, readiness, per-subject review, report/broadsheet entry points and clear publication wording. Class display names already include arms; do not create a competing arm model.
- Keep the tested new lifecycle: draft → compiled → reviewed → published → locked. Legacy submitted/approved/archive states are not added. Reviewed is the principal's final sign-off; school-wide staff can inspect the read-only review grid. Compile: principal, vice principal, exam officer. Review sign-off, publish, lock and reversals: principal only. Teachers continue using CA; assignment-specific class-teacher results views remain a gap.
- Legacy inline score moderation and force-publishing incomplete results are not ported: corrections use CA/marking services after an audited reversal, and missing assessment components stay incomplete. No frontend calculation or approval bypass.
- Existing Next.js compilation counts any mark as completeness, ignores subject registration and has no role/lifecycle guard. These must be corrected before exposing it. Reuse computeTotal, gradeFor, rank, canTransition, requiresReason and the shared term lock.
- School settings already reserve JSON storage for academic rules but have no grading/ranking reader or editor. Define and document validated `gradingScale` and `rankingPolicy` settings using the existing domain types, alongside CA's existing `assessmentComponents`. Require explicit valid configuration to compile; never silently guess a school's policy. Components sum to 100 and contain exactly one exam, matching legacy validation.
- Legacy CBT writes a weighted examination component. Next.js stores raw answers. Normalize one finished, fully marked examination paper to the configured exam maximum using the candidate's assigned question maxima. Multiple applicable examination papers lack an approved aggregation policy: show this gap and block completeness rather than sum them. Practice, cancelled and unfinished attempts do not count.
- The schema stores subject results, not frozen class term summaries or component snapshots. Show subject positions and a clearly labeled stored-subject total; do not fabricate an official overall class position or promotion decision. Persist compilation input fingerprint in the existing audit metadata and reject review/publication when inputs or configuration changed.

## Visual and functional gaps retained for later work

The dashboard links existing reports and broadsheets; it does not redesign them. Existing logoUrl, address and principalName fields do not establish legacy parity. Crest watermark/background, tiled school-name watermark, contact line, named class-teacher signature resolution, signature image/text storage, remark rules/overrides, grade legend matching a custom stored scale, promotion remarks, QR verification, bulk report printing and average-based frozen class ranking need dedicated parity work. There are no dedicated term-summary, signature or remark-rule tables in the new schema. Do not hide these gaps in arbitrary fields or claim print-test success proves branding parity. Existing teacher/family result-access workflows require a separate parity/security review.

Navigation integration and school academic-settings UI remain follow-ups. No production school settings are changed by this feature.

## Configuration contract

The dashboard reads `schools.settings.assessmentComponents` (the existing CA contract), `schools.settings.gradingScale` (the domain `GradingScale` shape: id, name, version, bands with min/grade/remark) and `schools.settings.rankingPolicy` (tiePolicy, tiebreakers, rankIncomplete). Bands must have unique thresholds including zero. Components must have unique keys, positive maxima totaling 100, and exactly one examination component. No setup editor or guessed default is included. Preserve the school's approved policy when populating these settings.

Compilation is atomic across the selected class's active enrolled students and registered subjects. Incomplete totals retain `complete=false`, an empty grade, and the domain's configured ranking behavior. Final review/publication/locking refuse incomplete cohorts regardless of rankIncomplete. Full-cohort recompilation is required after score or rule changes. The old exported compileSubject delegates to the guarded service; term-wide transitionResults now requires an explicit classId to avoid accidentally publishing every class.

Examination corrections use the same term lock and block closed results; an authorized correction makes the subject result draft/incomplete. The review screen does not edit scores. Scope is the active cohort in the chosen session; durable historical class membership/result snapshots remain part of the missing term-summary model.

The report-card and broadsheet entry points also filter enrollments/results to the selected term's session. Previously an arbitrary active enrollment from another session could label a report or appear in a broadsheet. This is a scope correction for the dashboard links; print structure and visual templates are unchanged.
