"""
Report-card QA samples.

    python3 scripts/sample-report-cards.py [--out .qa-samples]

Renders the legacy-parity report card in every variant a school will actually
print, for VISUAL inspection (npm run test:print asserts page counts; this
script produces the sheets a human should look at):

  short/long names · 5/9/14/19 subjects · crest present/absent · passport
  photo present/absent · missing remarks · incomplete results

Output is NOT committed: it is QA evidence, regenerated on demand. The one-page
density behaviour is asserted separately by scripts/test-print.py.
"""

import argparse
import base64
import weasyprint

CSS = open('src/app/print.css').read()

CREST_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">'
             '<circle cx="48" cy="48" r="40" fill="#14532d"/>'
             '<path d="M24 60 L48 28 L72 60" fill="none" stroke="#fff" stroke-width="6"/>'
             '</svg>')
CREST_URL = 'data:image/svg+xml;base64,' + base64.b64encode(CREST_SVG.encode()).decode()

SUBJECTS = [
    'Mathematics', 'English Language', 'Basic Science', 'Social Studies',
    'Civic Education', 'Business Studies', 'Computer Studies',
    'Agricultural Science', 'Christian Religious Studies', 'Home Economics',
    'Fine Arts', 'French', 'Yoruba', 'Physical and Health Education',
    'Basic Technology', 'Security Education', 'Music', 'History',
    'Economics',
]
LONG_SUBJECT = ('Christian Religious Studies and Comparative Moral Instruction '
                'for Senior Secondary Candidates')
LONG_NAME = 'Oluwafunmilayo Adebayo-Ogundimu Chukwuemeka'
SHORT_NAME = 'Inioluwa Olayiwola'


def density(n):
    if n <= 9:
        return 'fit-roomy'
    if n <= 11:
        return 'fit-snug'
    if n <= 14:
        return 'fit-tight'
    return 'fit-overflow'


def row(subject, scored=True, complete=True, remark='Very Good'):
    if not scored:
        return (f'<tr><td class="subject">{subject}</td>'
                + '<td class="dash">—</td>' * 8 + '</tr>')
    ca, exam, total = 18, 54, 72
    pos = '<span class="not-ranked">not ranked</span>' if not complete else '3rd'
    grade = '' if not complete else 'B2'
    remark_cell = remark if complete else 'Incomplete'
    return (f'<tr><td class="subject">{subject}</td>'
            f'<td class="num">{ca}</td><td class="num">{exam}</td>'
            f'<td class="num"><strong>{total}</strong></td>'
            f'<td class="grade">{grade or "—"}</td>'
            f'<td class="num">{pos}</td>'
            f'<td class="num">68.4</td><td class="num">95</td>'
            f'<td>{remark_cell}</td></tr>')


def sheet(n, name=SHORT_NAME, crest=True, photo=False, remark='Very Good',
          unscored=0, not_ranked=0, long_names=False):
    crest_img = f'<img class="doc__crest" src="{CREST_URL}" alt="">' if crest else ''
    wm_var = f' style="--doc-wm-crest:url({CREST_URL})"' if crest else ''
    wm_text = '' if crest else \
        '<div class="doc__wm-fallback" aria-hidden="true"><span>Demo International School</span></div>'
    photo_cell = ('<td rowspan="3" class="doc__photo-cell">'
                  f'<img class="doc__photo" src="{CREST_URL}" alt=""></td>') if photo else ''

    rows = ''
    for i in range(n):
        subject = LONG_SUBJECT if long_names else SUBJECTS[i % len(SUBJECTS)]
        if i < unscored:
            rows += row(subject, scored=False)
        elif i < unscored + not_ranked:
            rows += row(subject, complete=False)
        else:
            rows += row(subject, remark=remark)

    graded = n - unscored
    return (f'<div class="doc__sheet {density(n)}"{wm_var}>{wm_text}'
            f'<header class="doc__head">{crest_img}'
            '<p class="doc__school">Demo International School</p>'
            '<p class="doc__address">12 Ring Road, Ibadan, Oyo State</p>'
            '<p class="doc__contact">0803 000 0000  •  info@demointernational.edu.ng</p></header>'
            '<p class="doc__title">Terminal Report Sheet</p>'
            f'<table class="doc__bio"><tbody><tr>{photo_cell}'
            f'<td class="label">Name:</td><td><strong>{name}</strong></td>'
            '<td class="label">Admission No.:</td><td>2026010001</td></tr>'
            '<tr><td class="label">Class:</td><td>JSS 1 A</td>'
            '<td class="label">Session:</td><td>2026/2027</td></tr>'
            '<tr><td class="label">Term:</td><td>First Term</td>'
            '<td class="label">No. in Class:</td><td>32</td></tr></tbody></table>'
            '<table class="doc__table"><thead><tr>'
            '<th class="subject">Subject</th><th>CA</th><th>Exam</th><th>Total</th>'
            '<th class="grade">Grade</th><th>Pos.</th><th>Class Avg</th><th>Highest</th>'
            f'<th class="subject">Remark</th></tr></thead><tbody>{rows}</tbody></table>'
            '<div class="doc__summary">'
            f'<div class="doc__stat"><b>{graded}</b><span>Subjects</span></div>'
            f'<div class="doc__stat"><b>{72 * max(graded - not_ranked, 0)}</b><span>Total Score</span></div>'
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
            'F9: 0\u201339 (Fail). Scale <em>waec-9</em> v1.</p></div>')


VARIANTS = [
    ('01-short-name-5-subjects',   dict(n=5)),
    ('02-long-name-9-subjects',    dict(n=9, name=LONG_NAME)),
    ('03-standard-9-photo-crest',  dict(n=9, photo=True)),
    ('04-fourteen-subjects-tight', dict(n=14, photo=True)),
    ('05-nineteen-subjects-overflow', dict(n=19)),
    ('06-no-crest-text-watermark', dict(n=9, crest=False)),
    ('07-no-photo',                dict(n=5, photo=False)),
    ('08-missing-remarks',        dict(n=9, remark='—')),
    ('09-incomplete-result',       dict(n=9, unscored=2, not_ranked=2)),
    ('10-long-names-19',          dict(n=19, long_names=True, name=LONG_NAME)),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='.qa-samples')
    args = ap.parse_args()

    import os
    os.makedirs(args.out, exist_ok=True)

    pages_total = 0
    for slug, kw in VARIANTS:
        body = sheet(**kw)
        html = (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
                f'<style>{CSS}</style></head><body>'
                f'<div class="doc">{body}</div></body></html>')
        doc = weasyprint.HTML(string=html).render()
        path = f'{args.out}/{slug}.pdf'
        doc.write_pdf(path)
        pages_total += len(doc.pages)
        print(f'{path}  {len(doc.pages)} page(s)')

    print(f'\n{len(VARIANTS)} samples, {pages_total} pages total — inspect '
          f'{args.out}/ visually before sign-off.')


if __name__ == '__main__':
    main()
