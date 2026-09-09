"""Minimal version-comparison evidence for the legacy empty fixed layer."""
import weasyprint

print('WeasyPrint', weasyprint.__version__)
for label, offsets in [('legacy inset', 'inset:0'), ('physical offsets', 'top:0;right:0;bottom:0;left:0')]:
    doc = weasyprint.HTML(string=f'<style>@page{{size:A4;margin:10mm}} .wm{{position:fixed;{offsets}}}</style><div class="wm"></div><p>probe</p>').render()
    def walk(box):
        if box.element is not None and box.element.get('class') == 'wm':
            print(label, 'box:', round(box.width, 2), 'x', round(box.height, 2))
        for child in box.all_children():
            walk(child)
    walk(doc.pages[0]._page_box)
