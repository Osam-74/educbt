import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { FAQS, articleBySlug } from '@/lib/help/registry';
import { viewerRole } from '@/lib/help/viewer';
import { ROLE_LABEL } from '@/lib/help/roles';

export const metadata: Metadata = { title: 'Frequently asked questions' };

const GROUPS: { id: string; title: string }[] = [
  { id: 'account', title: 'Account & sign-in' },
  { id: 'school', title: 'School management' },
  { id: 'examinations', title: 'Examinations' },
  { id: 'teachers', title: 'Teachers' },
  { id: 'students', title: 'Students & parents' },
];

export default async function FaqPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  if (FAQS.length === 0) notFound();
  const { role } = await viewerRole((await searchParams).role);
  const shown = FAQS.filter((f) => !role || !f.audience || f.audience.includes('all') || f.audience.includes(role));
  return (
    <>
      <nav className="hc-crumbs" aria-label="Breadcrumb"><Link href="/help">Help</Link><span aria-hidden="true">/</span><span>FAQ</span></nav>
      <h1 className="hc-title">Frequently asked questions</h1>
      {role && <p className="hc-muted">Showing questions for <strong>{ROLE_LABEL[role]}</strong>. <Link href="/help/faq?role=all">Show all</Link></p>}
      {GROUPS.map((g) => {
        const items = shown.filter((f) => f.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="hc-faq" aria-labelledby={`faq-${g.id}`}>
            <h2 id={`faq-${g.id}`} className="hc-h2">{g.title}</h2>
            {items.map((f) => {
              const art = f.article ? articleBySlug(f.article) : null;
              return (
                <details key={f.id} id={f.id}>
                  <summary>{f.question}</summary>
                  {f.answer.map((t, i) => <p key={i}>{t}</p>)}
                  {art && <p><Link href={`/help/${art.category}/${art.slug}`}>Read: {art.title}</Link></p>}
                </details>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
