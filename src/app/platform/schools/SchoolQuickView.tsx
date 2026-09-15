'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PaIcon } from '../icons';
import { CopyButton } from '../CopyButton';

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

      {open ? (
        <div className="pa-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="pa-modal-card pa-quickview-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="pa-quickview-close" aria-label="Close" onClick={() => setOpen(false)}>
              <PaIcon name="close" width={15} height={15} />
            </button>

            <div className="pa-quickview-head">
              <CrestThumb logoUrl={school.logoUrl} size={48} />
              <div>
                <h3>{school.name}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span className="pa-code-badge">{school.code}</span>
                  <span className={STATUS_PILL[school.status] ?? 'pa-pill'}>{school.status}</span>
                </div>
              </div>
            </div>

            <div className="pa-detail-facts pa-quickview-facts">
              <div>
                <span className="pa-section-label">Contact</span>
                <b>{school.email || school.phone ? [school.email, school.phone].filter(Boolean).join(' · ') : '—'}</b>
              </div>
              <div>
                <span className="pa-section-label">Address</span>
                <b>{school.address ?? '—'}</b>
              </div>
              <div>
                <span className="pa-section-label">Web address</span>
                {url ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <b className="pa-num">{school.customDomain ?? school.subdomain}</b>
                    <CopyButton value={url} label="" />
                  </div>
                ) : <b>Not set</b>}
              </div>
              <div>
                <span className="pa-section-label">Administrator</span>
                <b>{school.principalName ?? 'No principal on record'}</b>
                {school.principalLoginId ? (
                  <div className="pa-cell-sub">{school.principalLoginId}{school.principalCode ? ` · ${school.principalCode}` : ''}</div>
                ) : null}
              </div>
              <div>
                <span className="pa-section-label">Administrator email</span>
                <b>{school.principalEmail ?? '—'}</b>
              </div>
              <div>
                <span className="pa-section-label">Created</span>
                <b>{school.createdAt.toLocaleDateString('en-GB')}</b>
              </div>
            </div>

            <div className="pa-modal-actions">
              <Link href={`/platform/schools/${school.id}/edit`} className="pa-btn pa-btn--outline pa-btn--block">
                <PaIcon name="edit" width={14} height={14} /> Edit
              </Link>
              <Link href={`/platform/schools/${school.id}`} className="pa-btn pa-btn--primary pa-btn--block">
                Full details
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
