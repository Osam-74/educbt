import Link from 'next/link';
import { ROLE_CHOICES, speaksTo } from '@/lib/help/roles';
import { ARTICLES, popularArticles, searchIndex, visibleCategories, articlesIn } from '@/lib/help/registry';
import { HelpSearch } from '@/components/help/HelpSearch';
import { HelpIcon } from '@/components/help/HelpIcon';
import { viewerRole } from '@/lib/help/viewer';

export default async function HelpHome({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const sp = await searchParams;
  const { role, own } = await viewerRole(sp.role);
  const cats = visibleCategories();
  const popular = popularArticles().filter((a) => speaksTo(a.audience, role)).slice(0, 6);
  const forRole = role ? ARTICLES.filter((a) => a.audience.includes(role)).slice(0, 8) : [];

  return (
    <>
      <section className="hc-hero">
        <h1>How can we help?</h1>
        <p>Plain, step-by-step guides for everything in EduCBT.</p>
        <HelpSearch index={searchIndex()} />
      </section>

      <section aria-labelledby="hc-role">
        <h2 id="hc-role" className="hc-h2">I am a&hellip;</h2>
        <div className="hc-roles">
          {ROLE_CHOICES.map((r) => (
            <Link key={r.id} href={role === r.id ? (own === r.id ? '/help?role=all' : '/help') : `/help?role=${r.id}`} className={`hc-role ${role === r.id ? 'is-on' : ''}`} aria-pressed={role === r.id}>
              <strong>{r.label}</strong><span>{r.blurb}</span>
            </Link>
          ))}
        </div>
        {role && forRole.length > 0 && (
          <ul className="hc-list">
            {forRole.map((a) => <li key={a.slug}><Link href={`/help/${a.category}/${a.slug}`}>{a.title}</Link><span>{a.description}</span></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="hc-cats">
        <h2 id="hc-cats" className="hc-h2">Browse by topic</h2>
        <div className="hc-cards">
          {cats.map((c) => (
            <Link key={c.id} href={`/help/${c.id}`} className="hc-card">
              <HelpIcon name={c.icon} />
              <strong>{c.title}</strong>
              <span>{c.description}</span>
              <em>{c.id === 'faq' ? 'Quick answers' : `${articlesIn(c.id).length} article${articlesIn(c.id).length === 1 ? '' : 's'}`}</em>
            </Link>
          ))}
        </div>
      </section>

      {popular.length > 0 && (
        <section aria-labelledby="hc-pop">
          <h2 id="hc-pop" className="hc-h2">Popular guides</h2>
          <ul className="hc-list">
            {popular.map((a) => <li key={a.slug}><Link href={`/help/${a.category}/${a.slug}`}>{a.title}</Link><span>{a.description}</span></li>)}
          </ul>
        </section>
      )}
    </>
  );
}
