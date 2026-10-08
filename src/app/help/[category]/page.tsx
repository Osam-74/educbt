import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CATEGORY_BY_ID } from '@/lib/help/categories';
import { audienceLabel } from '@/lib/help/roles';
import { articlesIn } from '@/lib/help/registry';
import type { HelpCategoryId } from '@/lib/help/types';

type P = { params: Promise<{ category: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const c = CATEGORY_BY_ID[(await params).category as HelpCategoryId];
  return { title: c?.title ?? 'Help' };
}

export default async function CategoryPage({ params }: P) {
  const id = (await params).category as HelpCategoryId;
  const cat = CATEGORY_BY_ID[id];
  if (!cat || id === 'faq') notFound();
  const list = articlesIn(id);
  if (list.length === 0) notFound();

  return (
    <>
      <nav className="hc-crumbs" aria-label="Breadcrumb"><Link href="/help">Help</Link><span aria-hidden="true">/</span><span>{cat.title}</span></nav>
      <h1 className="hc-title">{cat.title}</h1>
      <p className="hc-lead">{cat.description}</p>
      <ul className="hc-list hc-list--big">
        {list.map((a) => (
          <li key={a.slug}>
            <Link href={`/help/${a.category}/${a.slug}`}>{a.title}</Link>
            <span>{a.description}</span>
            <em>For: {audienceLabel(a.audience)}</em>
          </li>
        ))}
      </ul>
    </>
  );
}
