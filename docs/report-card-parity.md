# Report card — legacy visual parity

Route: `/portal/reports/[studentId]`. No migrations, no new entities, no global navigation or portal-shell changes. This document records what was ported from the legacy WordPress plugin, what was measured, and what still blocks exact parity.

## Legacy reference (read directly, commit "Initial CBT plugin backup")

- `includes/Services/ReportCardDocument.php` — sheet structure, density ladder, watermark markup
- `includes/Services/DocumentBrandingService.php` — the authoritative print stylesheet (lines ~223–530)
- `includes/Services/SignatureService.php` — signature mark types (image / script-font text) and storage intent
- `includes/Services/RemarkService.php` — auto-remark bands by average; NOT ported (see Gaps)
- `assets/css/educbt-print.css` — generic print doc rules

Ported intent, not PHP. Legacy behaviors deliberately NOT reproduced: html2canvas rasterised PDFs, Dompdf, wp_hash QR verify, the 90°-rotated crest watermark, per-school wp_options styling.

## What was reproduced

- Exact title "TERMINAL REPORT SHEET" (12pt, letterspaced, uppercase)
- Document identity: Times New Roman 11pt, ink `#1a1a1a`, muted `#555`, rules `#6b6b6b`, school name green `#14532d` at 17pt
- Letterhead: crest 24mm centred above the name, address line, contact line (" • " joined), 2pt rule
- Bio block: Name / Admission No. / Class / Session / Term / No. in Class, dotted underlines; passport-photo cell (25×30mm) only when a photo exists, omitted entirely otherwise
- Marks table: Subject / CA / Exam / Total / Grade / Pos. / Class Avg / Highest / Remark; centred except Subject; ordinal positions (`1st`, `2nd`, `3rd`); em-dashes for registered-but-unscored subjects; "not ranked" stated for incomplete rows
- Summary: Subjects / Total Score / Average % / Position in Class (ordinal, competition policy from the stored `rankingPolicy`)
- Grading key: one-line bands `A1: 75–100 (Excellent) | …` from the domain scale + scale annotation
- Remarks: "Class Teacher's Remark:" / "Principal's Remark:" on underlined rules
- Signatures: two 42mm boxes, printed name on the rule, role in small caps; class teacher resolved from the live `class_teacher` assignment, principal from `schools.principalName`
- Watermark: school crest as a repeating 11cm background (`--doc-wm-crest`, repeat-y, center 6cm) faded by a 90% white veil; school-name text slanted -32° at 7% opacity when no crest exists. Verified tiling in WeasyPrint by pixel-diff (bands at 6cm intervals, veiled green `(231,237,233)`)
- Density ladder: fit-roomy ≤9 / fit-snug ≤11 / fit-tight ≤14 / fit-overflow >14; overflow reuses the fit-tight floor (legacy: "padding and type never shrink below the fit-tight values") so a 15–24 subject sheet does not spill a lone signature block onto a second page
- Print engine: A4 portrait, 10mm margins, literal pt borders in `@media print`, `print-color-adjust: exact`, header repeat, row/signature break guards
- Toolbar: "Download / Print" + "Choose Save as PDF" hint (legacy wording; browser print engine is the supported path)

## Derived honestly (no invented values)

No. in Class, Class Avg, Highest and Position in Class are computed read-time from the SAME `subject_results` rows the lifecycle compiled — complete rows only, cohort = active enrollments in the class. The stored `subjectPosition` is shown as stored; nothing is recomputed per subject.

## Schema/data gaps still blocking exact parity

- `term_results` summary: legacy stored per-student totals/average/position/teacher+principal remarks/days present. Until it exists, Position in Class is read-time derived, and per-student remarks are shown as em-dashes (never faked).
- `remark_ranges` / auto-remarks at publish: subject-cell remarks come from the compile's grade remark; the summary auto-remark bands are not ported.
- Signatures: no `signatures` table. The signature AREA is rendered (empty), the printed name sits on the rule. The script-font fallback (`Petit Formal Script` stack) is wired in CSS, waiting for stored marks.
- QR verification: deliberately deferred (legacy used a guessable hash; the replacement must be HMAC with a server secret).
- Attendance (days present/total): legacy printed it from term_results even without a capture workflow; not printed here rather than faked.

## Measurement notes (WeasyPrint 66 and 69, Liberation Serif — CI parity)

- Fixed-layout column widths are on the HEADER cells (`nth-child`), with `box-sizing: border-box`. Measured failure modes fixed: content-box widths overflowed the page and computed the Remark column at negative width (every remark wrapped, +40mm); unclassed header cells sized from header text and collapsed Remark to 10mm.
- The one-page boundary is recorded in `scripts/test-print.py`: ≤24 subjects on one page (was 19 on the interim sheet; the parity letterhead is taller, but the density floor and column fixes more than pay for it). 40 subjects legitimately spans 2 pages with a half page of rows.
- Samples for visual inspection: `python3 scripts/sample-report-cards.py` → `.qa-samples/` (not committed).

## Tests

```text
npm run typecheck
npm run build                       # needs DATABASE_URL_APP (fails closed by design)
npm run test:domain                 # no database — 55 checks incl. 8 new ordinal checks
npm run test:print                  # WeasyPrint — 14 density spec + 15 fixed + 4 broadsheet
```

Integration suites (`src/db/test-*.ts`) are unchanged and need the disposable Postgres fixtures per their own docs; this change touches no migration, RLS, or service they cover beyond the report page's read-only queries.

## Out of scope (per handoff)

Portal sidebar/navigation, CA entry, results lifecycle transitions (only READ the rows it stores), broadsheet Pos column/CSV (P1 backlog), bulk report pack.
