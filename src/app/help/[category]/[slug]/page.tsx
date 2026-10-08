import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CATEGORY_BY_ID } from '@/lib/help/categories';
import { audienceLabel } from '@/lib/help/roles';
import { ARTICLES, articleBySlug, neighbours } from '@/lib/help/registry';
import { Blocks } from '@/components/help/Blocks';

type P = { params: Promise<{ category: string; slug: string }> };

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ category: a.category, slug: a.slug }));
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const a = articleBySlug((await params).slug);
  return a ? { title: a.title, description: a.description } : { title: 'Help' };
}

export default async function ArticlePage({ params }: P) {
  const { category, slug } = await params;
  const a = articleBySlug(slug);
  // The category in the URL must be the article's real category, so there is exactly one address per article.
  if (!a || a.category !== category) notFound();
  const cat = CATEGORY_BY_ID[a.category];
  const { prev, next } = neighbours(a);
  const related = (a.related ?? []).map(articleBySlug).filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <article className="hc-article">
      <nav className="hc-crumbs" aria-label="Breadcrumb">
        <Link href="/help">Help</Link><span aria-hidden="true">/</span>
        <Link href={`/help/${cat.id}`}>{cat.title}</Link><span aria-hidden="true">/</span>
        <span>{a.title}</span>
      </nav>
      <h1 className="hc-title">{a.title}</h1>
      <p className="hc-lead">{a.description}</p>
      <div className="hc-meta">
        <span><b>For:</b> {audienceLabel(a.audience)}</span>
        {a.where && <span><b>Where:</b> {a.where}</span>}
      </div>
      <div className="hc-prose"><Blocks blocks={a.blocks} /></div>

      {related.length > 0 && (
        <section className="hc-related" aria-labelledby="hc-rel">
          <h2 id="hc-rel">Related guides</h2>
          <ul>{related.map((r) => <li key={r.slug}><Link href={`/help/${r.category}/${r.slug}`}>{r.title}</Link></li>)}</ul>
        </section>
      )}
      <nav className="hc-pager" aria-label="More in this topic">
        {prev ? <Link href={`/help/${prev.category}/${prev.slug}`}><small>Previous</small>{prev.title}</Link> : <span />}
        {next ? <Link href={`/help/${next.category}/${next.slug}`} className="is-next"><small>Next</small>{next.title}</Link> : <span />}
      </nav>
    </article>
  );
}
