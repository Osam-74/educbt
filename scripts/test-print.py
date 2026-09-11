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
    wm_layer = ('<div class="doc__wm">' + f'<img src="{CREST_URL}" alt="">' * 3 + '</div>') if crest else ''
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
                 '<td class="num">18.5</td><td class="num">54.5</td>'
                 f'<td class="num"><strong>72.5</strong></td><td class="grade">{grade}</td>'
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

    return (f'<div class="doc__sheet {density(n)}"{wm_var}>{wm_layer}{wm_text}{head}'
            '<table class="doc__table"><colgroup><col class="c-subject" /><col class="c-ca" /><col class="c-exam" /><col class="c-total" /><col class="c-grade" /><col class="c-pos" /><col class="c-avg" /><col class="c-high" /><col class="c-remark" /></colgroup><thead><tr>'
            '<th class="subject">Subject</th><th>CA</th><th>Exam</th><th>Total</th>'
            '<th class="grade">Grade</th><th>Pos.</th><th>Class Avg</th><th>Highest</th>'
            '<th>Remark</th></tr></thead>'
            f'<tbody>{rows}</tbody></table>{tail}</div>')


def render(sheets, extra_css=''):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<style>{CSS}{extra_css}</style></head><body>'
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
    # LONG_SUBJECT is a 92-character name — far past any real subject — and
    # wraps to three lines in the 62mm Subject column, so a 12-row sheet of
    # ONLY that name runs to a second page. Recorded as measured: the guard
    # is that the layout survives the input, not that absurd content is
    # forced onto one sheet (see the readability note on the density ladder).
    # Realistic names wrap to one line; '12 subjects' in the ladder above
    # proves the one-page boundary with them.
    ('long subject names',       [sheet(12, subject_name=LONG_SUBJECT)],  2),
    ('long student name',        [sheet(12, student_name=LONG_NAME)],     1),
    ('long name AND long subjects',
     [sheet(12, subject_name=LONG_SUBJECT, student_name=LONG_NAME)],      2),

    # ── NOT RANKED / incomplete ─────────────────────────────────────────────
    # >14 subjects renders at roomy sizes and flows to a second page (the
    # legacy density ladder stops compacting at fit-tight/14); page 2
    # carries real rows, not a lone signature spill.
    ('16 with 2 not ranked',     [sheet(16, not_ranked=2)],     2),
    ('every subject not ranked', [sheet(9, not_ranked=9)],      1),

    # ── Watermark paths: crest background AND text fallback ─────────────────
    ('crest watermark 9',        [sheet(9, crest=True)],        1),
    ('crest watermark 16',      [sheet(16, crest=True)],       2),
    ('text watermark 9',        [sheet(9)],                    1),

    # ── Bio variants: photo cell present ────────────────────────────────────
    ('photo cell 9',            [sheet(9, photo=True)],        1),

    # ── Realistic class batches ─────────────────────────────────────────────
    ('batch of 3 cards',         [sheet(9)] * 3,                3),
    ('batch of 10 cards',        [sheet(9)] * 10,              10),
    ('class of 30, 16 subjects', [sheet(16)] * 30,             60),
    ('class of 45, 9 subjects',  [sheet(9)] * 45,              45),
    ('mixed batch',             [sheet(9), sheet(16), sheet(9)], 4),
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
    # (CI parity). The one-page boundary is the LEGACY ladder: compacting
    # stops at fit-tight (14 subjects); sheets beyond it render at roomy
    # sizes and flow to a second page carrying real rows. Readability beats
    # squeezing another row onto sheet one — an earlier revision forced
    # 15-24 onto one page at tight sizes and was reverted on review.
    spec = [('1 subjects', 1), ('5 subjects', 1), ('9 subjects', 1), ('10 subjects', 1),
            ('11 subjects', 1), ('12 subjects', 1), ('14 subjects', 1), ('15 subjects', 2),
            ('16 subjects', 2), ('18 subjects', 2), ('19 subjects', 2), ('20 subjects', 2),
            ('24 subjects', 2), ('40 subjects', 2)]
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




def veil_probe(failures):
    """The white veil must cover EVERY page of a multi-page sheet.

    The failure this guards against shipped to review twice: the crest is a
    repeating page background, but the veil was an absolutely-positioned
    ::before - painted once, clipped at the page-1 fragment - so page two
    printed the crest at 100% opacity behind the closing block, and the
    region after the results table on page one showed it raw too. The crest
    now lives on a position:fixed layer with opacity .15 - the one
    positioned-box mode that repeats on EVERY page in both print engines. Asserted at the pixel
    level: the crest tile's centre on EVERY page of a 19-subject (2-page)
    sheet must be the veiled tone - dark green #14532d seen through 90%
    white is ~(219,229,223), luminance ~224; the raw crest is ~49 and bare
    paper is 255. A veiled-AND-present window of 200-250 proves both."""
    import io
    import pypdfium2 as pdfium
    print()
    print('\u2014 Watermark veil on every page \u2014')
    doc = render([sheet(19, crest=True)])
    buf = io.BytesIO(); doc.write_pdf(buf); buf.seek(0)
    pdf = pdfium.PdfDocument(buf)
    n_pages = len(pdf)
    # Keep identical layout/pagination but hide foreground ink for spacing
    # probes. A report-table glyph at 180mm is not an overlapping watermark.
    watermark_doc = render([sheet(19, crest=True)],
        '.doc__sheet > :not(.doc__wm) { opacity: 0 }')
    watermark_buf = io.BytesIO(); watermark_doc.write_pdf(watermark_buf); watermark_buf.seek(0)
    watermark_pdf = pdfium.PdfDocument(watermark_buf)
    assert len(watermark_pdf) == n_pages, 'Watermark isolation must preserve pagination'
    ok_pages = n_pages == 2
    if not ok_pages:
        failures += 1
        print(f'FAIL  veil 19-subject sheet is {n_pages} page(s), expected 2')
    for i, page in enumerate(pdf):
        img = page.render(scale=1.5).to_pil().convert('RGB')
        px = img.load()
        mm_x = img.width / 210
        mm_y = img.height / 297
        # crest tile centre: x = sheet centre (105mm); tile top at the 10mm
        # margin + 6cm offset, tile is 11cm tall -> centre at 125mm
        cx, cy = int(105 * mm_x), int(125 * mm_y)
        patch = [px[cx + dx, cy + dy] for dx in (-4, 0, 4) for dy in (-4, 0, 4)]
        lum = max(sum(c) / 3 for c in patch)
        ok = 200 <= lum <= 250
        if not ok:
            failures += 1
        print(f'{"PASS" if ok else "FAIL"}  veil page {i + 1:<10}(crest-centre luminance '
              f'{lum:.0f}; veiled is ~224, raw crest ~49)')
        # Verify the second tile and the clear gap between circular test
        # crests. Presence at one point alone missed overlapping copies on page 2.
        watermark_img = watermark_pdf[i].render(scale=1.5).to_pil().convert('RGB')
        darkest = min(sum(rgb) / 3 for rgb in watermark_img.getdata())
        clean = darkest >= 200
        if not clean:
            failures += 1
        print(f'{"PASS" if clean else "FAIL"}  watermark-only page {i + 1} (minimum luminance {darkest:.0f})')
        for label, y, minimum, maximum in [('second tile', 235, 200, 250), ('tile gap', 180, 250, 255)]:
            tx, ty = int(105 * mm_x), int(y * mm_y)
            tile_lum = sum(watermark_img.getpixel((tx, ty))) / 3
            ok = minimum <= tile_lum <= maximum
            if not ok:
                failures += 1
            print(f'{"PASS" if ok else "FAIL"}  {label} page {i + 1} (luminance {tile_lum:.0f})')
    return failures


def bleed_probe(failures):
    """No cell content may cross a column edge.

    The failure this guards against shipped to review: the single-word
    HIGHEST header (12.8mm at the roomy 8.5pt header size) sat in a column
    whose content box was ~9mm, and bled into the Remark column. A line box
    wider than its cell's content box means text crossed the border —
    regardless of how it looks at a glance. Checked at every density's
    header size (roomy 8.5pt is the worst case, tight 8pt re-verified) with
    realistic bodies: long subject names, "not ranked", wrapped remarks.
    """
    print()
    print('\u2014 No column bleed \u2014')
    cases = [
        ('roomy 9', sheet(9, subject_name='Subject With A Very Long Name For Wrapping')),
        ('tight 14', sheet(14, not_ranked=2)),
        ('overflow 19', sheet(19)),
    ]
    for label, body in cases:
        doc = render([body])
        worst = 0.0
        where = ''
        def walk(box):
            nonlocal worst, where
            if getattr(box, 'element_tag', None) in ('th', 'td'):
                cls = ' '.join(box.element.get('class', '').split())
                lines = [l for l in box.descendants() if type(l).__name__ == 'LineBox']
                for line in lines:
                    over = line.width - box.width
                    if over > worst:
                        worst = over
                        where = cls or box.element_tag
            for c in getattr(box, 'children', []):
                walk(c)
        for page in doc.pages:
            walk(page._page_box)
        ok = worst <= 1.0  # 1px tolerance for font kerning rounding
        if not ok:
            failures += 1
        print(f'{"PASS" if ok else "FAIL"}  no bleed {label:<12}'
              f'(worst overflow {worst:.1f}px in {where or "-"} cell)')
    return failures


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
    failures = bleed_probe(failures)
    failures = veil_probe(failures)
    failures = broadsheet_checks(failures)

    print()
    if failures:
        print(f'{failures} PRINT CHECK(S) FAILED')
        sys.exit(1)
    print('Print layout holds — every sheet paginates as expected.')
