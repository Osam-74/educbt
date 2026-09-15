'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { PaIcon } from '../icons';

const STATUS_PILL: Record<string, string> = {
  active: 'pa-pill pa-pill--active',
  suspended: 'pa-pill pa-pill--suspended',
  archived: 'pa-pill pa-pill--archived',
};

/** The subset of SchoolSummary the quick-view card needs. Deliberately a
 * plain serializable shape (no functions) — passed straight from a server
 * component's already-fetched row, so opening the quick view is instant and
 * never triggers a second request. */
export type QuickViewSchool = {
  id: number;
  name: string;
  code: string;
  status: string;
  logoUrl: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  subdomain: string | null;
  customDomain: string | null;
  principalName: string | null;
  principalLoginId: string | null;
  principalCode: string | null;
  principalEmail: string | null;
  createdAt: Date;
};

/** A school's crest if it has one, or the same building-icon tile used
 * everywhere else in Platform Admin as a graceful fallback. Used in the
 * schools table, mobile cards, the dashboard's "Recently created" table, and
 * this quick-view card, so every crest-bearing surface looks consistent. */
export function CrestThumb({ logoUrl, size = 32 }: { logoUrl: string | null; size?: number }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- small DB-backed data URL, not a Next/Image-optimizable remote asset
      <img src={logoUrl} alt="" className="pa-crest-thumb" style={{ width: size, height: size }} />
    );
  }
  return (
    <span className="pa-icon-tile" style={{ width: size, height: size }}>
      <PaIcon name="building" width={Math.round(size * 0.45)} height={Math.round(size * 0.45)} />
    </span>
  );
}

/** The card content, portalled straight to document.body so it renders as a
 * true viewport modal — never a descendant of the schools table's scrollable
 * / overflow-managed panel, which is what was clipping it before. */
function QuickViewModal({ school, url, onClose }: { school: QuickViewSchool; url: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="pa-modal-backdrop" id="school-quickview-backdrop" onClick={onClose}>
      <div className="pa-schoolview-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pa-schoolview-close" aria-label="Close" onClick={onClose}>
          <PaIcon name="close" width={15} height={15} />
        </button>

        <div className="pa-detail-header">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <CrestThumb logoUrl={school.logoUrl} size={44} />
            <div>
              <h2 className="pa-detail-title" style={{ fontSize: 17 }}>{school.name}</h2>
              <div className="pa-detail-meta">
                <span className="pa-code-badge">{school.code}</span>
                <span className={STATUS_PILL[school.status] ?? 'pa-pill'}>{school.status}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pa-schoolview-body">
          <div className="pa-subdomain-box">
            <span className="pa-section-label" style={{ marginBottom: 8 }}><PaIcon name="globe" width={14} height={14} /> Web address</span>
            {url ? (
              <div className="pa-url-row">
                <span>{url}</span>
                <button
                  type="button"
                  className="pa-url-copy"
                  aria-label={copied ? 'Web address copied' : 'Copy web address'}
                  title={copied ? 'Copied' : 'Copy address'}
                  onClick={() => {
                    navigator.clipboard.writeText(url).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? <PaIcon name="check" width={14} height={14} /> : <PaIcon name="copy" width={14} height={14} />}
                </button>
              </div>
            ) : (
              <p style={{ fontSize: 12.5, color: 'var(--pa-stone-500)' }}>Not set — this school signs in only from the platform&apos;s own sign-in page.</p>
            )}
          </div>

          <div>
            <div className="pa-section-label"><PaIcon name="userCheck" width={14} height={14} /> Administrator</div>
            {school.principalName ? (
              <div className="pa-detail-facts">
                <div><span>Full name</span><b>{school.principalName}</b></div>
                <div><span>Sign-in ID</span><b className="pa-num" style={{ fontSize: 12.5 }}>{school.principalLoginId ?? '—'}</b></div>
                <div><span>Code</span><b>{school.principalCode ?? '—'}</b></div>
                <div><span>Email</span><b>{school.principalEmail ?? '—'}</b></div>
              </div>
            ) : (
              <p style={{ fontSize: 12.5, color: 'var(--pa-stone-500)' }}>No principal is on record for this school.</p>
            )}
          </div>

          <div>
            <div className="pa-section-label">School &amp; contact</div>
            <div className="pa-contact-list">
              <div><PaIcon name="mail" width={15} height={15} /> {school.email ?? 'No official contact email provided'}</div>
              <div><PaIcon name="phone" width={15} height={15} /> {school.phone ?? 'No contact phone provided'}</div>
              <div><PaIcon name="mapPin" width={15} height={15} /> {school.address ?? 'Standard cluster deployment'}</div>
              <div><PaIcon name="calendar" width={15} height={15} /> Created {school.createdAt.toLocaleDateString('en-GB')}</div>
            </div>
          </div>
        </div>

        <div className="pa-schoolview-actions">
          <Link href={`/platform/schools/${school.id}/edit`} className="pa-btn pa-btn--outline pa-btn--sm">
            <PaIcon name="edit" width={13} height={13} /> Edit School
          </Link>
          <Link href={`/platform/schools/${school.id}`} className="pa-btn pa-btn--primary pa-btn--sm">
            Full Details
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The eye-icon trigger + the quick-view modal itself, for one row/card. */
export function QuickViewButton({ school, url }: { school: QuickViewSchool; url: string | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="pa-btn pa-btn--ghost pa-btn--sm"
        title="Quick view"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
      >
        <PaIcon name="eye" width={13} height={13} />
      </button>
      {open ? <QuickViewModal school={school} url={url} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
