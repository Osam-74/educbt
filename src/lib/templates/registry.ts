/**
 * Document template registry — the single list of print designs a school can
 * be assigned for each document type. Adding a template = add an entry here +
 * a `.tpl-<key>` block in src/app/templates.css. No migration needed: the
 * database stores only the key (validated against this list).
 *
 * "classic" is the original print.css look and has NO css block: it must stay
 * visually identical to what schools print today.
 */
export const DOC_KINDS = ['report', 'transcript', 'broadsheet'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  report: 'Terminal report card',
  transcript: 'Academic transcript',
  broadsheet: 'Broadsheet',
};

export const TEMPLATES = [
  { key: 'classic',  label: 'Classic',  tagline: 'The original EduCBT sheet — Times, green letterhead, plain grid.', swatch: ['#14532d', '#ececec', '#1a1a1a'] },
  { key: 'heritage', label: 'Heritage', tagline: 'Navy and gold, double-ruled letterhead, small-caps labels. Traditional.', swatch: ['#14213d', '#b08d2f', '#f4efe0'] },
  { key: 'metro',    label: 'Metro',    tagline: 'Modern sans-serif, left-aligned letterhead, teal bar, zebra rows.', swatch: ['#0f766e', '#f59e0b', '#ecfdf5'] },
  { key: 'ledger',   label: 'Ledger',   tagline: 'Black-and-white hairline rules, no fills. Best for photocopying.', swatch: ['#111111', '#888888', '#ffffff'] },
  { key: 'royal',    label: 'Royal',    tagline: 'Burgundy page frame and banner title. Certificate feel.', swatch: ['#7a1f2b', '#a8822b', '#fbf3f3'] },
  { key: 'bright',   label: 'Bright',   tagline: 'Rounded, colourful, friendly type. For nursery and primary.', swatch: ['#2563eb', '#f97316', '#eff6ff'] },
] as const;

export type TemplateKey = (typeof TEMPLATES)[number]['key'];
export const DEFAULT_TEMPLATE: TemplateKey = 'classic';

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === 'string' && TEMPLATES.some((t) => t.key === value);
}

/** CSS class for the root `.doc` element. Classic adds nothing. */
export function templateClass(key: TemplateKey): string {
  return key === 'classic' ? '' : `tpl-${key}`;
}

/**
 * Resolution order: the school's own assignment → the platform default →
 * classic. An unknown stored key (a template removed later) falls through
 * rather than breaking printing.
 */
export function resolveTemplate(schoolValue: unknown, platformDefault: unknown): TemplateKey {
  if (isTemplateKey(schoolValue)) return schoolValue;
  if (isTemplateKey(platformDefault)) return platformDefault;
  return DEFAULT_TEMPLATE;
}
