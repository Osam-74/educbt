"""
Print verification.

    npm run test:print

Renders report cards at several subject counts and COUNTS THE PAGES.

This exists because the WordPress system's printing was never actually printed
during development. It looked correct in a browser preview and produced report
cards that started halfway down a page, bled into the next, and left blank
leaves behind. Nobody found out until a school printed a class set.

Two bugs in this stylesheet were caught by this script rather than by review:

  - `position: absolute` on the document container. Out-of-flow content does not
    paginate, so a batch of three report cards printed on ONE page.
  - The signature block spilling alone onto a nearly empty second page at
    sixteen subjects, doubling a school's paper for nothing.

Neither was visible in a single-page preview.
"""

import re
import sys
import weasyprint

CSS = open('src/app/print.css').read()

HEAD = '''<header class="doc__head">
<p class="doc__school">Demo International School</p>
<p class="doc__address">12 Ring Road, Ibadan, Oyo State</p>
<p class="doc__title">Terminal Report Sheet</p></header>
<table class="doc__bio"><tbody>
<tr><td class="label">Name:</td><td><strong>Inioluwa Olayiwola</strong></td>
<td class="label">Admission No.:</td><td>2026010001</td></tr>
<tr><td class="label">Class:</td><td>JSS 1 A</td>
<td class="label">Session:</td><td>2026/2027</td></tr>
</tbody></table>'''

TAIL = '''<div class="doc__summary">
<div class="doc__stat"><b>16</b><span>Subjects ranked</span></div>
<div class="doc__stat"><b>1152</b><span>Total</span></div>
<div class="doc__stat"><b>72.0%</b><span>Average</span></div></div>
<div class="doc__remarks"><p><strong>Class Teacher:</strong> <span class="line"></span></p>
<p><strong>Principal:</strong> <span class="line"></span></p></div>
<div class="doc__signs">
<div class="doc__sign"><div class="rule"></div><div class="name">Class Teacher</div>
<div class="role">Signature &amp; Date</div></div>
<div class="doc__sign"><div class="rule"></div><div class="name">Dr. S. Okonkwo</div>
<div class="role">Principal</div></div></div>
<p class="doc__grading-key"><strong>Grading:</strong> A1 75-100 · B2 70-74 · B3 65-69 ·
C4 60-64 · C5 55-59 · C6 50-54 · D7 45-49 · E8 40-44 · F9 0-39.
Scale <em>waec-9</em> v1.</p>'''


def sheet(n, not_ranked=0):
    rows = ''
    for i in range(n):
        pos = ('<span class="not-ranked">not ranked</span>'
               if i < not_ranked else f'{(i % 20) + 1}/32')
        rows += (f'<tr><td>Subject Number {i+1} With A Long Name</td>'
                 f'<td class="num">18</td><td class="num">54</td>'
                 f'<td class="num"><strong>72</strong></td><td class="grade">B2</td>'
                 f'<td class="num">{pos}</td><td>Very Good</td></tr>')

    return (f'<div class="doc__sheet">{HEAD}'
            f'<table class="doc__table"><thead><tr><th>Subject</th><th class="num">CA</th>'
            f'<th class="num">Exam</th><th class="num">Total</th><th class="grade">Grade</th>'
            f'<th class="num">Pos.</th><th>Remark</th></tr></thead><tbody>{rows}</tbody></table>'
            f'{TAIL}</div>')


def render(sheets):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<style>{CSS}</style></head><body>'
            f'<div class="doc">{"".join(sheets)}</div></body></html>')

    return weasyprint.HTML(string=html).render()


CASES = [
    ('9 subjects',              [sheet(9)],                    1),
    ('16 subjects',             [sheet(16)],                   1),
    ('16 with 2 not ranked',    [sheet(16, not_ranked=2)],     1),
    ('24 subjects',             [sheet(24)],                   2),
    ('batch of 3 cards',        [sheet(9)] * 3,                3),
    ('batch of 10 cards',       [sheet(9)] * 10,              10),
    ('batch of 30, 16 subjects', [sheet(16)] * 30,            30),
]

failures = 0

for name, sheets, expected in CASES:
    pages = len(render(sheets).pages)
    ok = pages == expected
    if not ok:
        failures += 1

    note = ''
    if not ok and pages < expected:
        note = '  — sheets collapsed; check the document is not out of flow'
    elif not ok and pages > expected:
        note = '  — a nearly empty trailing page wastes a school\'s paper'

    print(f'{"PASS" if ok else "FAIL"}  {name:<26}{pages} page(s), expected {expected}{note}')

# A class set must not carry a blank leaf between cards.
thirty = render([sheet(16)] * 30)
print(f'{"PASS" if len(thirty.pages) == 30 else "FAIL"}  '
      f'{"no blank page between cards":<26}30 cards produced {len(thirty.pages)} pages')

if len(thirty.pages) != 30:
    failures += 1

print('\nPrint output is correct.' if failures == 0
      else f'\n{failures} print check(s) FAILED.')

sys.exit(0 if failures == 0 else 1)
