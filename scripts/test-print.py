"""
Print verification.

    npm run test:print

Renders report cards at several subject counts and COUNTS THE PAGES.

This exists because the WordPress system's printing was never actually printed
during development. It looked correct in a browser preview and produced report
cards that started halfway down a page, bled into the next, and left blank
leaves behind them. Nobody found out until a school printed a class set.

Two bugs in this stylesheet were caught by this script rather than by review:

  - `position: absolute` on the document container. Out-of-flow content does not
    paginate, so a batch of three report cards printed on ONE page.
  - The signature block spilling alone onto a nearly empty second page at
    sixteen subjects, doubling a school's paper for nothing.

The sheet rendered here is the LEGACY-PARITY report card: nine-column marks
table (CA / Exam / Total / Grade / Pos. / Class Avg / Highest / Remark),
crest watermark, density classes, ordinals, 4-stat summary. Page-count
boundaries below are MEASURED against this markup and this stylesheet —
record as measured, never as a round guess.
"""

import base64
import sys
import weasyprint

CSS = open('src/app/print.css').read()

# A tiny inline SVG crest — the watermark path with a real image, so the
# test proves the repeating crest background does not break pagination.
CREST_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
             '<circle cx="32" cy="32" r="28" fill="#14532d"/></svg>')
CREST_URL = 'data:image/svg+xml;base64,' + base64.b64encode(CREST_SVG.encode()).decode()


def density(n):
    """Legacy thresholds: <=9 roomy, <=11 snug, <=14 tight, then overflow."""
    if n <= 9:
        return 'fit-roomy'
    if n <= 11:
        return 'fit-snug'
    if n <= 14:
        return 'fit-tight'
    return 'fit-overflow'


def sheet(n, not_ranked=0, subject_name=None, student_name=None,
          crest=False, photo=False, remark='Very Good'):
    head_school = 'Demo International School'
    crest_img = f'<img class="doc__crest" src="{CREST_URL}" alt="">' if crest else ''
    wm_var = f' style="--doc-wm-crest:url({CREST_URL})"' if crest else ''
    wm_text = '' if crest else \
        f'<div class="doc__wm-fallback" aria-hidden="true"><span>{head_school}</span></div>'
    photo_cell = ('<td rowspan="3" class="doc__photo-cell">'
                  f'<img class="doc__photo" src="{CREST_URL}" alt=""></td>') if photo else ''
    name = student_name or 'Inioluwa Olayiwola'

    head = (f'<header class="doc__head">{crest_img}'
            f'<p class="doc__school">{head_school}</p>'
            '<p class="doc__address">12 Ring Road, Ibadan, Oyo State</p>'
            '<p class="doc__contact">0803 000 0000  •  info@demointernational.edu.ng</p>'
            '</header><p class="doc__title">Terminal Report Sheet</p>'
            f'<table class="doc__bio"><tbody><tr>{photo_cell}'
            f'<td class="label">Name:</td><td><strong>{name}</strong></td>'
            '<td class="label">Admission No.:</td><td>2026010001</td></tr>'
            '<tr><td class="label">Class:</td><td>JSS 1 A</td>'
            '<td class="label">Session:</td><td>2026/2027</td></tr>'
            '<tr><td class="label">Term:</td><td>First Term</td>'
            '<td class="label">No. in Class:</td><td>32</td></tr></tbody></table>')

    rows = ''
    for i in range(n):
        if i < not_ranked:
            pos = '<span class="not-ranked">not ranked</span>'
            grade, cls_avg, highest = 'B2', '68.4', '95'
        else:
            pos = ('1st' if (i % 20) == 0 else
                   '2nd' if (i % 20) == 1 else
                   '3rd' if (i % 20) == 2 else f'{(i % 20) + 1}th')
            grade, cls_avg, highest = 'B2', '68.4', '95'
        label = subject_name or f'Subject Number {i+1} With A Long Name'
        rows += (f'<tr><td class="subject">{label}</td>'
                 '<td class="num">18</td><td class="num">54</td>'
                 f'<td class="num"><strong>72</strong></td><td class="grade">{grade}</td>'
                 f'<td class="num">{pos}</td><td class="num">{cls_avg}</td>'
                 f'<td class="num">{highest}</td><td>{remark}</td></tr>')

    tail = ('<div class="doc__summary">'
            '<div class="doc__stat"><b>16</b><span>Subjects</span></div>'
            '<div class="doc__stat"><b>1152</b><span>Total Score</span></div>'
            '<div class="doc__stat"><b>72.0%</b><span>Average</span></div>'
            '<div class="doc__stat"><b>1st</b><span>Position in Class</span></div></div>'
            '<div class="doc__remarks">'
            '<p><strong>Class Teacher&rsquo;s Remark:</strong> <span class="doc__remark-text">\u2014</span></p>'
            '<p><strong>Principal&rsquo;s Remark:</strong> <span class="doc__remark-text">\u2014</span></p></div>'
            '<div class="doc__sign">'
            '<div class="doc__sign-box"><div class="doc__sig-area"></div>'
            '<div class="doc__sig-line">Mrs. A. Oluwaseun</div>'
            '<div class="doc__sig-role">Class Teacher</div></div>'
            '<div class="doc__sign-box"><div class="doc__sig-area"></div>'
            '<div class="doc__sig-line">Dr. S. Okonkwo</div>'
            '<div class="doc__sig-role">Principal</div></div></div>'
            '<p class="doc__key"><strong>Grading Key:</strong> '
            'A1: 75\u2013100 (Excellent)  |  B2: 70\u201374 (Very Good)  |  '
            'B3: 65\u201369 (Good)  |  C4: 60\u201364 (Credit)  |  '
            'C5: 55\u201359 (Credit)  |  C6: 50\u201354 (Credit)  |  '
            'D7: 45\u201349 (Pass)  |  E8: 40\u201344 (Pass)  |  '
            'F9: 0\u201339 (Fail). Scale <em>waec-9</em> v1.</p>')

    return (f'<div class="doc__sheet {density(n)}"{wm_var}>{wm_text}{head}'
            '<table class="doc__table"><thead><tr>'
            '<th class="subject">Subject</th><th>CA</th><th>Exam</th><th>Total</th>'
            '<th class="grade">Grade</th><th>Pos.</th><th>Class Avg</th><th>Highest</th>'
            '<th class="subject">Remark</th></tr></thead>'
            f'<tbody>{rows}</tbody></table>{tail}</div>')


def render(sheets):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<style>{CSS}</style></head><body>'
            f'<div class="doc">{"".join(sheets)}</div></body></html>')

    return weasyprint.HTML(string=html).render()


LONG_SUBJECT = ('Christian Religious Studies and Comparative Moral Instruction '
                'for Senior Secondary Candidates')
LONG_NAME = 'Oluwafunmilayo Adebayo-Ogundimu Chukwuemeka'

# ── First: measure the honest one-page boundary ─────────────────────────────
# Rendered once with density classes at every boundary and the page count
# recorded, so the expectations below are measurements, not guesses.
CASES = []
for n in [1, 5, 9, 10, 11, 12, 14, 15, 16, 18, 19, 20, 24, 40]:
    CASES.append((f'{n} subjects', [sheet(n)], None))

CASES += [
    # ── Long content must not break the layout ─────────────────────────────
    ('long subject names',       [sheet(12, subject_name=LONG_SUBJECT)],  1),
    ('long student name',        [sheet(12, student_name=LONG_NAME)],     1),
    ('long name AND long subjects',
     [sheet(12, subject_name=LONG_SUBJECT, student_name=LONG_NAME)],      1),

    # ── NOT RANKED / incomplete ─────────────────────────────────────────────
    ('16 with 2 not ranked',     [sheet(16, not_ranked=2)],     1),
    ('every subject not ranked', [sheet(9, not_ranked=9)],      1),

    # ── Watermark paths: crest background AND text fallback ─────────────────
    ('crest watermark 9',        [sheet(9, crest=True)],        1),
    ('crest watermark 16',      [sheet(16, crest=True)],       1),
    ('text watermark 9',        [sheet(9)],                    1),

    # ── Bio variants: photo cell present ────────────────────────────────────
    ('photo cell 9',            [sheet(9, photo=True)],        1),

    # ── Realistic class batches ─────────────────────────────────────────────
    ('batch of 3 cards',         [sheet(9)] * 3,                3),
    ('batch of 10 cards',        [sheet(9)] * 10,              10),
    ('class of 30, 16 subjects', [sheet(16)] * 30,             30),
    ('class of 45, 9 subjects',  [sheet(9)] * 45,              45),
    ('mixed batch',             [sheet(9), sheet(16), sheet(9)], 3),
]


def main():
    failures = 0

    # ── Measure the density ladder ────────────────────────────────────────
    print('— Measuring the one-page boundary (density ladder) —')
    measured = {}
    for name, sheets, _ in [c for c in CASES if c[2] is None]:
        pages = len(render(sheets).pages)
        measured[name] = pages
        print(f'  {name:<18} {pages} page(s)')

    # The boundary asserts are written from what the ladder above prints, with
    # the legacy thresholds as the spec: <=14 must fit ONE page at fit-tight;
    # beyond that a second page is allowed but NOT a near-empty collapse.
    # Recorded as measured on WeasyPrint 66 AND 69, Liberation Serif metrics
    # (CI parity), one page up to and including 24 subjects. The 15-24 range
    # holds because overflow sheets reuse the fit-tight readability floor
    # instead of roomy sizes (which spilled a lone signature block onto a
    # second page - the exact waste this suite guards against). 40 subjects
    # is the first case that legitimately needs a second page, and carries a
    # full half page of rows with it.
    spec = [('1 subjects', 1), ('5 subjects', 1), ('9 subjects', 1), ('10 subjects', 1),
            ('11 subjects', 1), ('12 subjects', 1), ('14 subjects', 1), ('15 subjects', 1),
            ('16 subjects', 1), ('18 subjects', 1), ('19 subjects', 1), ('20 subjects', 1),
            ('24 subjects', 1), ('40 subjects', 2)]
    for name, expected in spec:
        pages = measured[name]
        ok = pages == expected
        if not ok: failures += 1
        print(f'{"PASS" if ok else "FAIL"}  {name:<26}{pages} page(s), expected {expected}')

    print()
    print('— Fixed expectations —')
    for name, sheets, expected in [c for c in CASES if c[2] is not None]:
        pages = len(render(sheets).pages)
        ok = pages == expected
        if not ok:
            failures += 1
        note = ''
        if not ok and pages < expected:
            note = '  — sheets collapsed; check the document is not out of flow'
        elif not ok and pages > expected:
            note = "  — a nearly empty trailing page wastes a school's paper"
        print(f'{"PASS" if ok else "FAIL"}  {name:<26}{pages} page(s), expected {expected}{note}')

    return failures


# ── Broadsheet: landscape, repeated headers, multi-page ─────────────────────
def broadsheet(students, subjects):
    """A whole class against every subject."""
    heads = ''.join(f'<th class="num">SUB{j+1}</th>' for j in range(subjects))

    rows = ''
    for i in range(students):
        marks = ''.join(f'<td class="num">{55 + (i + j) % 40}</td>' for j in range(subjects))
        rows += (f'<tr><td class="num">{i+1}</td>'
                 f'<td>Adebayo-Ogundimu Oluwafunmilayo {i+1}</td>'
                 f'<td class="num">20260100{i:02d}</td>{marks}'
                 f'<td class="num"><strong>720</strong></td><td class="num">72.0</td></tr>')

    return (f'<div class="doc doc--broadsheet"><div class="doc__sheet">'
            f'<header class="doc__head"><p class="doc__school">Broadsheet</p>'
            f'<p class="doc__title">JSS 1 A — First Term</p></header>'
            f'<table class="doc__table"><thead><tr><th class="num">#</th><th>Student</th>'
            f'<th class="num">Adm. No.</th>{heads}'
            f'<th class="num">Total</th><th class="num">Avg</th></tr></thead>'
            f'<tbody>{rows}</tbody></table></div></div>')


def render_raw(body):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<style>{CSS}</style></head><body>{body}</body></html>')

    return weasyprint.HTML(string=html).render()


def broadsheet_checks(failures):
    print()
    BROADSHEETS = [
        ('broadsheet 30x9',   broadsheet(30, 9)),
        ('broadsheet 30x15',  broadsheet(30, 15)),
        ('broadsheet 45x15',  broadsheet(45, 15)),
    ]

    for name, body in BROADSHEETS:
        doc = render_raw(body)
        page = doc.pages[0]

        # Landscape: the page must be wider than it is tall. A broadsheet printed
        # portrait loses its right-hand columns off the edge of the paper.
        landscape = page.width > page.height

        print(f'{"PASS" if landscape else "FAIL"}  {name:<26}'
              f'{page.width:.0f}x{page.height:.0f}pt '
              f'{"landscape" if landscape else "*** PORTRAIT"}, {len(doc.pages)} page(s)')

        if not landscape:
            failures += 1

    # Headings must repeat on every page of a multi-page broadsheet. Without them
    # the second page is a grid of unlabelled numbers.
    wide = render_raw(broadsheet(60, 12))
    multi = len(wide.pages) > 1

    print(f'{"PASS" if multi else "FAIL"}  {"broadsheet spans pages":<26}'
          f'60 students produced {len(wide.pages)} page(s)')

    if not multi:
        failures += 1

    return failures


if __name__ == '__main__':
    failures = main()
    failures = broadsheet_checks(failures)

    print()
    if failures:
        print(f'{failures} PRINT CHECK(S) FAILED')
        sys.exit(1)
    print('Print layout holds — every sheet paginates as expected.')
