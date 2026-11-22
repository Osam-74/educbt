"""Template guard: every template must keep the report card on the same page
budget as classic and must not bleed text across column edges.

    python3 scripts/test-templates.py      (run from repo root; needs weasyprint)

Mirrors scripts/test-print.py's bleed_probe + the legacy page ladder
(<=14 subjects: 1 page; 19 subjects: 2 pages)."""
import importlib.util, sys
import weasyprint

spec = importlib.util.spec_from_file_location('samples', 'scripts/sample-report-cards.py')
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
PRINT = open('src/app/print.css').read()
TPL = open('src/app/templates.css').read()
KEYS = ['classic', 'heritage', 'metro', 'ledger', 'royal', 'bright']
CASES = [('roomy 9', dict(n=9, photo=True), 1),
         ('long names 9', dict(n=9, long_names=True), None),   # None = must not exceed classic
         ('tight 14 not-ranked', dict(n=14, not_ranked=2), 1),
         ('overflow 19', dict(n=19), 2)]

def render(key, **kw):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>{PRINT}\n{TPL}</style></head>'
            f'<body><div class="doc tpl-{key}">{S.sheet(**kw)}</div></body></html>')
    return weasyprint.HTML(string=html).render()

def worst_bleed(doc):
    worst = 0.0
    def walk(box):
        nonlocal worst
        if getattr(box, 'element_tag', None) in ('th', 'td'):
            for line in [l for l in box.descendants() if type(l).__name__ == 'LineBox']:
                worst = max(worst, line.width - box.width)
        for c in getattr(box, 'children', []):
            walk(c)
    for p in doc.pages: walk(p._page_box)
    return worst

fails = 0
for key in KEYS:
    for label, kw, pages in CASES:
        doc = render(key, **kw)
        bleed = worst_bleed(doc)
        want = pages if pages is not None else len(render('classic', **kw).pages)
        ok = len(doc.pages) <= want and bleed <= 1.0
        fails += (not ok)
        print(f'{"PASS" if ok else "FAIL"}  {key:<9} {label:<22} pages={len(doc.pages)} (max {want})  worst bleed={bleed:.1f}px')
print(f'\n{fails} failure(s)'); sys.exit(1 if fails else 0)
