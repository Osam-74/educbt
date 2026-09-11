# School Settings + Academic Configuration

## Reference audit (before implementation)

Legacy: Osam-74/cbt at `0864e950a161f1bc2ffdb1744a35694fcebf3c90`.
Inspected `templates/portal/school/settings.php`, `school/signatures.php`,
`school/remarks.php`, `teacher/signatures.php`, `teacher/remarks.php`,
`includes/Core/Capabilities.php`, `includes/Frontend/PortalActions.php`, and
`includes/Services/{SchoolService,AcademicYearService,GradingService,SignatureService,RemarkService}.php`.

The legacy uses grouped settings cards, current session/term selection, creation
of a session with three terms, named weighted assessments, school identity and
crest upload. School code is deliberately read-only. Principal-only capabilities
govern school, academic-year and grading changes; VP/Exam Officer inheritance
does not grant these capabilities. Preserve those boundaries with server checks.

## Schema mismatches and intended compatibility rules

* Profile/contact/crest/principal-name columns already exist. Keep school code
  immutable. Use validated, bounded raster uploads; never accept SVG or HTML as
  signatures. Do not copy the legacy fallback from missing staff ID to user ID.
* Sessions/terms exist, with nullable dates. Creation and current-period changes
  must be school-scoped, serialized, and verify that the term belongs to the
  selected session. Do not assume a September school calendar.
* Assessment components are global school JSON, not term-versioned rows. Freeze
  keys, maxima and exam designation once scores or results exist; labels may
  change. A future migration tool is required for historical weight changes.
  Coordinate configuration writes with existing CA/result transaction locks.
* Grade bands use minimum thresholds, not independent inclusive min/max pairs.
  Show the upper boundary derived from the next minimum (exclusive), with 100
  included in the highest band. This partitions decimal scores without gaps.
  New immutable scale snapshots will explain stored IDs/versions; never rewrite
  compiled grades or invent missing historical scales.
* Ranking uses the existing tiePolicy/tiebreakers/rankIncomplete shape. Changes
  affect subsequent compilation; existing results keep their stored policy.
* There are no signature or report-remark tables. Add small school/staff/role
  scoped relational records. Only actual authorized staff may maintain their
  own signature. Never select an arbitrary other teacher's signature.
* Legacy remark ranges are school/role scoped despite teacher-facing wording
  implying personal ranges. New personal ranges must have explicit staff scope.
  Manual remarks must remain distinct from automatic suggestions and obey the
  result lifecycle; do not mutate published remarks when a range changes.
* Legacy integrity thresholds (blur/hidden/suspicious) are not consumed by the
  current advisory event engine. Do not expose inert thresholds as working
  controls. Exam duration is supported and may provide a new-paper default;
  defaults must not change existing papers.
* Legacy grading supports stage-specific scales and pass flags; the current
  domain uses one school scale without those fields. This task preserves that
  domain rather than presenting unsupported controls.

All meaningful writes require transactionally recorded before/after audit data,
active school/user authorization, app-role access and forced tenant RLS. No
production migration or automatic merge is part of this feature task.
