import type { HelpArticle, HelpFaq } from './types';
import { CATEGORY_BY_ID } from './categories';

/**
 * Lightweight search. The CLIENT gets only a compact index (title, one-line
 * description, category, keywords, slug) — never article bodies — so /help
 * stays fast. The server results page also searches the article text.
 */
export type SearchEntry = {
  slug: string;
  title: string;
  description: string;
  category: string;
  categoryTitle: string;
  keywords: string[];
};

export function toEntry(a: HelpArticle): SearchEntry {
  return {
    slug: a.slug,
    title: a.title,
    description: a.description,
    category: a.category,
    categoryTitle: CATEGORY_BY_ID[a.category].title,
    keywords: a.keywords,
  };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ');
const tokens = (s: string) => norm(s).split(/\s+/).filter(Boolean);

/** Cheap stemming so "students" matches "student" and "passwords" matches "password". */
const stem = (w: string) => (w.length > 3 ? w.replace(/(ies)$/, 'y').replace(/(es|s|ing|ed)$/, '') : w);

export function scoreEntry(e: SearchEntry, query: string, body = ''): number {
  const q = tokens(query).map(stem);
  if (q.length === 0) return 0;
  const title = tokens(e.title).map(stem);
  const kw = e.keywords.flatMap((k) => tokens(k)).map(stem);
  const desc = tokens(e.description).map(stem);
  const cat = tokens(e.categoryTitle).map(stem);
  const text = body ? tokens(body).map(stem) : [];
  const whole = norm(query).trim();
  let total = 0;
  for (const w of q) {
    let s = 0;
    if (title.includes(w)) s += 10;
    else if (title.some((t) => t.startsWith(w) || w.startsWith(t))) s += 6;
    if (kw.includes(w)) s += 7;
    else if (kw.some((t) => t.startsWith(w))) s += 4;
    if (desc.includes(w)) s += 3;
    // Examinations / Results / Account area: a topic's home area is a strong hint of intent.
    if (cat.some((t) => t === w || t.startsWith(w))) s += 6;
    if (text.includes(w)) s += 1;
    if (s === 0) return 0; // every word must match somewhere
    total += s;
  }
  if (norm(e.title).includes(whole)) total += 8;
  return total;
}

export function searchEntries(entries: SearchEntry[], query: string, limit = 8): SearchEntry[] {
  return entries
    .map((e) => ({ e, s: scoreEntry(e, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title))
    .slice(0, limit)
    .map((x) => x.e);
}

/** Plain text of an article, for body search on the server. */
export function articleText(a: HelpArticle): string {
  return a.blocks
    .map((b) => {
      switch (b.type) {
        case 'p': case 'h': case 'note': case 'warning': return b.text;
        case 'steps': case 'list': return b.items.join(' ');
        case 'table': return [...b.head, ...b.rows.flat()].join(' ');
        case 'figure': return b.figure.caption ?? '';
      }
    })
    .join(' ');
}

export function searchFaqs(faqs: HelpFaq[], query: string): HelpFaq[] {
  const q = tokens(query).map(stem);
  if (!q.length) return [];
  return faqs.filter((f) => {
    const hay = tokens(`${f.question} ${f.answer.join(' ')}`).map(stem);
    return q.every((w) => hay.includes(w));
  });
}
