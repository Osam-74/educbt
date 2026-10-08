'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type NavCategory = { id: string; title: string; articles: { slug: string; title: string }[] };

/**
 * Category + article navigation. A sidebar on desktop; on a phone it is a
 * drawer opened from the "Browse help" button, closed by choosing a page, the
 * backdrop, the close button, or Escape.
 */
export function HelpNav({ categories }: { categories: NavCategory[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open]);

  const list = (
    <nav aria-label="Help topics">
      <Link href="/help" className={`hc-nav__home ${pathname === '/help' ? 'is-current' : ''}`}>Help home</Link>
      {categories.map((c) => (
        <div key={c.id} className="hc-nav__group">
          <Link href={c.id === 'faq' ? '/help/faq' : `/help/${c.id}`} className={`hc-nav__cat ${pathname === `/help/${c.id}` ? 'is-current' : ''}`}>{c.title}</Link>
          {c.articles.length > 0 && pathname.startsWith(`/help/${c.id}`) && (
            <ul>
              {c.articles.map((a) => (
                <li key={a.slug}>
                  <Link href={`/help/${c.id}/${a.slug}`} className={pathname === `/help/${c.id}/${a.slug}` ? 'is-current' : ''} aria-current={pathname === `/help/${c.id}/${a.slug}` ? 'page' : undefined}>{a.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <button type="button" className="hc-browse" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Browse help
      </button>
      <aside className="hc-side">{list}</aside>
      {open && (
        <div className="hc-drawer" role="dialog" aria-modal="true" aria-label="Help topics">
          <button type="button" className="hc-drawer__backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="hc-drawer__panel">
            <div className="hc-drawer__head">
              <strong>Help Center</strong>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close menu">Close</button>
            </div>
            {list}
          </div>
        </div>
      )}
    </>
  );
}
