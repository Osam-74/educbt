import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { tenantFromHost } from '@/lib/tenant';
import { visibleCategories, articlesIn, searchIndex } from '@/lib/help/registry';
import { HelpSearch } from '@/components/help/HelpSearch';
import { HelpNav } from '@/components/help/HelpNav';
import './help.css';

export const metadata: Metadata = {
  title: { default: 'Help Center | EduCBT', template: '%s | EduCBT Help' },
  description: 'Step-by-step guides for running and using EduCBT.',
};

export const dynamic = 'force-dynamic';

export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  const school = await tenantFromHost((await headers()).get('host')).catch(() => null);
  const categories = visibleCategories().map((c) => ({
    id: c.id, title: c.title,
    articles: articlesIn(c.id).map((a) => ({ slug: a.slug, title: a.title })),
  }));

  return (
    <div className="hc">
      <header className="hc-top">
        <div className="hc-top__in">
          <Link href="/help" className="hc-brand">
            <span className="hc-brand__mark" aria-hidden="true">E</span>
            <span><strong>EduCBT</strong> Help Center{school ? <small>{school.name}</small> : null}</span>
          </Link>
          <div className="hc-top__search"><HelpSearch index={searchIndex()} size="sm" /></div>
          <nav className="hc-top__links" aria-label="Account">
            <Link href="/sign-in">Sign in</Link>
            <Link href="/portal" className="hc-top__cta">Open portal</Link>
          </nav>
        </div>
      </header>
      <div className="hc-body">
        <HelpNav categories={categories} />
        <main className="hc-main" id="main">{children}</main>
      </div>
      <footer className="hc-foot">
        Cannot find what you need? Ask your school office, they can see your account and what you have access to.
      </footer>
    </div>
  );
}
