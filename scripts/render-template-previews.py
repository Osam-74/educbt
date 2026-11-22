"""Render every template for report card, transcript, broadsheet using the
repo's real print.css + templates.css under WeasyPrint 69.
Run from the educbt repo root:  python3 render_previews.py [outdir]"""
import sys, os, importlib.util, weasyprint
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('samples', 'scripts/sample-report-cards.py')
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

PRINT = open('src/app/print.css').read()
TPL = open(os.environ.get('TPL_CSS', 'src/app/templates.css')).read()
KEYS = ['classic', 'heritage', 'metro', 'ledger', 'royal', 'bright']
out = sys.argv[1] if len(sys.argv) > 1 else '.template-previews'
os.makedirs(out, exist_ok=True)

def page(body_html, extra_css=''):
    return f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>{PRINT}\n{TPL}\n{extra_css}</style></head><body>{body_html}</body></html>'

def report(key, n=9):
    return page(f'<div class="doc tpl-{key}">{S.sheet(n=n, photo=True)}</div>')

def transcript(key):
    def tbl(term, rows):
        r = ''.join(f'<tr><td class="subject">{s}</td><td>{sc}</td><td>{g}</td></tr>' for s, sc, g in rows)
        return (f'<table class="doc__table" style="margin-bottom:3mm"><thead><tr><th style="text-align:left">{term} — Subject</th>'
                '<th style="width:18mm">Score</th><th style="width:18mm">Grade</th></tr></thead>'
                f'<tbody>{r}</tbody><tfoot><tr><td class="subject">Term average 71.4% &nbsp;·&nbsp; Position 3rd of 32</td><td colspan="2"></td></tr></tfoot></table>')
    rows = [('Mathematics', 78, 'A1'), ('English Language', 71, 'B2'), ('Basic Science', 66, 'B3'), ('Civic Education', 74, 'B2'), ('Computer Studies', 81, 'A1')]
    body = (f'<div class="doc tpl-{key}"><div class="doc__sheet">'
        f'<div class="doc__wm"><img src="{S.CREST_URL}" alt=""></div>'
        f'<header class="doc__head"><img class="doc__crest" src="{S.CREST_URL}" alt="">'
        '<p class="doc__school">Demo International School</p><p class="doc__address">12 Ring Road, Ibadan, Oyo State</p>'
        '<p class="doc__contact">0803 000 0000 · info@demointernational.edu.ng</p></header>'
        '<p class="doc__title">Academic Transcript</p>'
        '<table class="doc__bio"><tbody><tr><td class="label">Name</td><td><strong>Inioluwa Olayiwola</strong></td><td class="label">Admission No.</td><td>2026010001</td>'
        f'<td rowspan="3" style="width:27mm;text-align:center"><img class="doc__photo" src="{S.CREST_URL}" alt=""></td></tr>'
        '<tr><td class="label">Date of Birth</td><td>2013-04-02</td><td class="label">Sex</td><td>Female</td></tr>'
        '<tr><td class="label">Terms Recorded</td><td>3</td><td class="label">Status</td><td>Active</td></tr></tbody></table>'
        '<div class="doc__session"><h2 style="font-size:11pt;margin:5mm 0 2mm">2026/2027 &nbsp;·&nbsp; JSS 1 A</h2>'
        + tbl('First Term', rows) + tbl('Second Term', rows) + '</div>'
        '<div class="doc__tr-summary"><div class="doc__tr-stat"><b>3</b><span>Terms Recorded</span></div>'
        '<div class="doc__tr-stat"><b>71.4%</b><span>Cumulative Average</span></div><div class="doc__tr-stat"><b>1</b><span>Sessions</span></div></div>'
        '<p class="doc__tr-key">This transcript is a complete record of the internal academic results of the named student.</p>'
        '<div class="doc__serial"><span>Serial: <strong>TR-2026-00041</strong></span><span>Issued: 2026-11-22</span></div>'
        '</div></div>')
    return page(body)

def broadsheet(key):
    codes = ['MTH', 'ENG', 'BSC', 'SOS', 'CVE', 'BUS', 'CMP', 'AGR', 'CRS', 'FRN', 'YOR', 'PHE']
    names = ['Adebayo, Tunde', 'Chukwu, Ngozi', 'Danjuma, Aisha', 'Eze, Chinedu', 'Folarin, Kemi', 'Garba, Ibrahim', 'Hassan, Zainab', 'Ibe, Obinna', 'Johnson, Tola', 'Kalu, Amara']
    head = ''.join(f'<th>{c}</th>' for c in codes)
    body = ''
    for i, nme in enumerate(names):
        cells = ''.join(f'<td>{50 + (i * 7 + j * 5) % 48} <span class="doc__cell-grade">{"A1" if (i+j)%4==0 else "B2" if (i+j)%4==1 else "C4" if (i+j)%4==2 else "B3"}</span></td>' for j in range(len(codes)))
        body += f'<tr><td style="white-space:nowrap">{nme}</td>{cells}<td><strong>{640 + i * 11}</strong></td><td>{60 + i}.2</td><td>{i + 1}{"st" if i==0 else "nd" if i==1 else "rd" if i==2 else "th"}</td></tr>'
    html = (f'<div class="doc doc--broadsheet tpl-{key}"><div class="doc__sheet">'
        f'<header class="doc__head"><img class="doc__crest" src="{S.CREST_URL}" alt=""><div><p class="doc__school">Demo International School</p>'
        '<p class="doc__title">BROADSHEET</p><p class="doc__address">12 Ring Road, Ibadan, Oyo State</p></div></header>'
        '<p class="muted doc__meta-line">2026/2027 · First Term · 10 students · class average 70.4</p>'
        f'<table class="doc__table"><thead><tr><th>Student</th>{head}<th>Total</th><th>Avg</th><th>Pos</th></tr></thead><tbody>{body}</tbody></table>'
        '<p class="muted" style="margin-top:10px">A dash means the student does not offer that subject — it is not a zero.</p></div></div>')
    return page(html)

for key in KEYS:
    for name, html in (('report', report(key)), ('report-14', report(key, 14)), ('transcript', transcript(key)), ('broadsheet', broadsheet(key))):
        doc = weasyprint.HTML(string=html).render()
        p = f'{out}/{key}-{name}.pdf'; doc.write_pdf(p)
        print(f'{p}: {len(doc.pages)} page(s)')
