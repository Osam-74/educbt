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
- Marks table: Subject / CA / Exam / Total / Grade / Pos. / Class Avg / Highest / Remark, every column sized by an explicit `<colgroup>` (col.c-subject … col.c-remark) with measured bold-header widths and ≥0.5mm slack — the `bleed_probe` in `test-print.py` asserts no line box ever crosses a column edge; all headers centred except Subject; ordinal positions; em-dashes for registered-but-unscored subjects; "not ranked" stated for incomplete rows
- Summary: Subjects / Total Score / Average % / Position in Class (ordinal, competition policy from the stored `rankingPolicy`)
- Grading key: one-line bands `A1: 75–100 (Excellent) | …` from the domain scale + scale annotation
- Remarks: "Class Teacher's Remark:" / "Principal's Remark:" on underlined rules
- Signatures: two 42mm boxes, printed name on the rule, role in small caps; class teacher resolved from the live `class_teacher` assignment, principal from `schools.principalName`
- Watermark: school crest on a `position: fixed` layer (`--doc-wm-crest` inherited from the sheet, 11cm tiles, repeat-y, centered, 70mm from paper top) faded by the layer's own `opacity: .10` (same veiled tone as the legacy 90% white veil: crest `#14532d` → `(231,237,234)`); school-name text slanted -32° at 7% opacity when no crest exists. Fixed-position is the one positioned-box mode that REPEATS ON EVERY PRINTED PAGE in both engines (WeasyPrint server PDFs and window.print in Chrome). Two rejected designs, both shipped raw crests to review on multi-page sheets: a sheet background fragments in box coordinates (page two shows the tiling continuation, crest mid-tile in the wrong place) and an absolutely-positioned veil paints once, clipped at the first page fragment (page two bare of veil behind the signatures). Guarded by the `veil_probe` in `test-print.py`: pixel-samples the crest centre on EVERY page of a 19-subject sheet — luminance must sit in the veiled window 200–250 (measured 234 on both pages; raw crest is ~49)
- Density ladder: fit-roomy ≤9 / fit-snug ≤11 / fit-tight ≤14; sheets beyond 14 render at ROOMY sizes and flow to a second page (legacy stops compacting at fit-tight; an earlier revision reused the tight floor to force 15–24 subjects onto one page and was reverted on review — readability beats paper)
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
- The one-page boundary is the LEGACY ladder: ≤14 subjects on one page; 15–40 span two pages at roomy sizes with real rows (not a lone signature spill) carried onto page 2. The one-line/short-row guarantee holds: a realistic subject name wraps once at most.
- Column bleed is asserted, not eyeballed: `bleed_probe` renders roomy/tight/overflow sheets with decimals ("68.4"), "not ranked" and long names, then fails if any th/td line box exceeds its cell's content width. Both shipped bugs would have been caught: bold HIGHEST (13.8mm) in a 13mm column, and "68.4" overflowing a 10mm column's 5.1mm content box.
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
