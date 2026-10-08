import Link from 'next/link';
import type { Metadata } from 'next';
import { articleText, scoreEntry, toEntry, searchFaqs } from '@/lib/help/search';
import { ARTICLES, FAQS, searchIndex } from '@/lib/help/registry';
import { HelpSearch } from '@/components/help/HelpSearch';

export const metadata: Metadata = { title: 'Search' };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);
  // The full page also searches article text; the client box only searches titles and keywords.
  const hits = q
    ? ARTICLES.map((a) => ({ a, s: scoreEntry(toEntry(a), q, articleText(a)) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 20)
    : [];
  const faqHits = q ? searchFaqs(FAQS, q).slice(0, 8) : [];

  return (
    <>
      <h1 className="hc-title">Search</h1>
      <HelpSearch index={searchIndex()} initial={q} size="sm" />
      {q && (
        <p className="hc-muted" role="status">
          {hits.length + faqHits.length === 0 ? `No results for "${q}".` : `${hits.length + faqHits.length} result${hits.length + faqHits.length === 1 ? '' : 's'} for "${q}".`}
        </p>
      )}
      {hits.length > 0 && (
        <ul className="hc-list hc-list--big">
          {hits.map(({ a }) => <li key={a.slug}><Link href={`/help/${a.category}/${a.slug}`}>{a.title}</Link><span>{a.description}</span></li>)}
        </ul>
      )}
      {faqHits.length > 0 && (
        <>
          <h2 className="hc-h2">Quick answers</h2>
          <div className="hc-faq">
            {faqHits.map((f) => (
              <details key={f.id}><summary>{f.question}</summary>{f.answer.map((t, i) => <p key={i}>{t}</p>)}</details>
            ))}
          </div>
        </>
      )}
      {q && hits.length + faqHits.length === 0 && (
        <p>Try fewer or different words, or <Link href="/help">browse by topic</Link>. If you are still stuck, ask your school office.</p>
      )}
    </>
  );
}
