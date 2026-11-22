import { DOC_KINDS, DOC_KIND_LABEL, TEMPLATES, type DocKind, type TemplateKey } from '@/lib/templates/registry';

/**
 * The three "which design?" choices, shared by the per-school screen and the platform-default screen.
 * Each option shows its colour swatch and one-line description, and links to a live preview of that design on that
 * document, so the administrator sees exactly what a school will print before saving.
 *
 * `inheritLabel` adds a first "Inherit" choice (per-school only). `current` is the stored value: null means inherit.
 */
export function TemplateSelectors({ current, inheritLabel }: { current: Record<DocKind, TemplateKey | null>; inheritLabel?: string }) {
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {DOC_KINDS.map((kind) => (
        <fieldset key={kind} className="pa-card pa-card-pad" style={{ margin: 0, border: '1px solid var(--pa-stone-200)' }} data-testid={`template-group-${kind}`}>
          <legend style={{ padding: '0 6px', fontWeight: 750, color: 'var(--pa-forest)' }}>{DOC_KIND_LABEL[kind]}</legend>
          <div style={{ display: 'grid', gap: 8 }}>
            {inheritLabel ? (
              <label className="pa-confirm-row" style={{ alignItems: 'flex-start' }}>
                <input type="radio" name={kind} value="" defaultChecked={current[kind] === null} />
                <span><strong>{inheritLabel}</strong></span>
              </label>
            ) : null}
            {TEMPLATES.map((t) => (
              <label key={t.key} className="pa-confirm-row" style={{ alignItems: 'flex-start', gap: 10 }}>
                <input type="radio" name={kind} value={t.key} defaultChecked={current[kind] === t.key} required={!inheritLabel} />
                <span style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flex: 1 }}>
                  <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0, marginTop: 3 }}>
                    {t.swatch.map((c) => <span key={c} style={{ width: 14, height: 14, background: c, border: '1px solid rgba(0,0,0,.18)', marginRight: -1 }} />)}
                  </span>
                  <span style={{ flex: 1 }}>
                    <strong>{t.label}</strong>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--pa-stone-500)' }}>{t.tagline}</span>
                  </span>
                  <a href={`/platform/templates/preview?kind=${kind}&template=${t.key}`} target="_blank" rel="noreferrer" className="pa-btn pa-btn--ghost pa-btn--sm" style={{ flexShrink: 0 }}>Preview</a>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
