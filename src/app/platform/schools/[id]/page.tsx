import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { schoolDetail } from '@/lib/platform/schools';
import { bestSchoolUrl } from '@/lib/platform/tenant-url';
import { reactivateSchoolAction, suspendSchoolAction } from './actions';
import { PaIcon } from '../../icons';
import { CopyButton } from '../../CopyButton';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pa-pill pa-pill--active',
  suspended: 'pa-pill pa-pill--suspended',
  archived: 'pa-pill pa-pill--archived',
};

function fmt(d: Date) {
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function SchoolDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const flash = await searchParams;
  const actor = await requirePlatformSession();
  const schoolId = Number(id);

  if (!Number.isInteger(schoolId) || schoolId <= 0) notFound();

  const school = await schoolDetail(actor, schoolId).catch(() => null);

  if (!school) {
    return (
      <section className="pa-card pa-card-pad pa-empty">
        <strong>School not found</strong>
        <p>This school does not exist or was removed. Nothing else changed.</p>
        <Link href="/platform/schools" className="pa-btn pa-btn--primary">Back to schools</Link>
      </section>
    );
  }

  const platformDomain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase() || null;
  const url = bestSchoolUrl(school, platformDomain);
  const suspended = school.status !== 'active';

  return (
    <div id="school-detail-view">
      <p style={{ marginBottom: 12 }}>
        <Link href="/platform/schools" style={{ fontSize: 13, color: 'var(--pa-stone-500)', textDecoration: 'none' }}>
          &larr; All schools
        </Link>
      </p>

      {flash.ok ? <div className="pa-alert pa-alert--ok"><PaIcon name="checkCircle" width={16} height={16} />{flash.ok}</div> : null}
      {flash.error ? <div className="pa-alert pa-alert--error"><PaIcon name="alert" width={16} height={16} />{flash.error}</div> : null}

      <div className="pa-card" style={{ marginBottom: 20, overflow: 'hidden' }}>
        <div className="pa-detail-header">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            {school.logoUrl ? (
              <img src={school.logoUrl} alt="" className="pa-detail-icon" style={{ objectFit: 'cover' }} />
            ) : (
              <span className="pa-detail-icon"><PaIcon name="building" width={22} height={22} /></span>
            )}
            <div>
              <h2 className="pa-detail-title">{school.name}</h2>
              <div className="pa-detail-meta">
                <span className="pa-code-badge">{school.code}</span>
                <span className={STATUS_PILL[school.status] ?? 'pa-pill'}>{school.status}</span>
              </div>
            </div>
          </div>
          <Link href={`/platform/schools/${school.id}/edit`} className="pa-btn pa-btn--outline pa-btn--sm" style={{ flexShrink: 0, background: 'rgba(255,255,255,0.9)' }}>
            <PaIcon name="edit" width={13} height={13} /> Edit
          </Link>
        </div>

        <div className="pa-detail-body">
          <div className="pa-subdomain-box">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="pa-section-label" style={{ marginBottom: 0 }}><PaIcon name="globe" width={14} height={14} /> Sign-on address</span>
              {url ? <span style={{ fontSize: 11, color: 'var(--pa-emerald-800)', fontFamily: 'ui-monospace, monospace' }}>Active</span> : null}
            </div>
            {url ? (
              <div className="pa-url-row">
                <span>{url}</span>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <CopyButton value={url} label="Copy" />
                  <a href={url} target="_blank" rel="noreferrer" className="pa-btn pa-btn--ghost pa-btn--sm">
                    <PaIcon name="external" width={13} height={13} /> Open
                  </a>
                </div>
              </div>
            ) : (
              <p style={{ marginTop: 8, fontSize: 12.5, color: 'var(--pa-stone-500)' }}>
                No web address set yet — this school signs in only from the platform's own sign-in page for now.
              </p>
            )}
            {school.customDomain ? (
              <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--pa-stone-500)' }}>
                Verified custom domain in use. Platform subdomain: <span className="pa-num">{school.subdomain ?? 'not set'}</span>
              </p>
            ) : null}
          </div>

          <div>
            <div className="pa-section-label"><PaIcon name="userCheck" width={14} height={14} /> Assigned principal</div>
            {school.principalName ? (
              <div className="pa-detail-facts">
                <div><span>Full name</span><b>{school.principalName}</b></div>
                <div><span>Sign-in ID</span><b className="pa-num" style={{ fontSize: 12.5 }}>{school.principalLoginId}</b></div>
                <div className="pa-span-2"><span>Account status</span><b>{school.principalStatus ?? '—'}</b></div>
              </div>
            ) : (
              <p style={{ fontSize: 12.5, color: 'var(--pa-stone-500)' }}>
                No principal is on record for this school. Contact the development team to appoint one.
              </p>
            )}
          </div>

          <div>
            <div className="pa-section-label">Contact information</div>
            <div className="pa-contact-list">
              <div><PaIcon name="mail" width={15} height={15} /> {school.email ?? 'No official contact email provided'}</div>
              <div><PaIcon name="phone" width={15} height={15} /> {school.phone ?? 'No contact phone provided'}</div>
              <div><PaIcon name="mapPin" width={15} height={15} /> {school.address ?? 'Standard cluster deployment'}</div>
              <div><PaIcon name="calendar" width={15} height={15} /> Registered {fmt(school.createdAt)} · updated {fmt(school.updatedAt)}</div>
            </div>
          </div>

          <div>
            <div className="pa-section-label">Academic setup</div>
            <p style={{ fontSize: 12, color: 'var(--pa-stone-500)', marginBottom: 10 }}>
              How far the school has set itself up. Counts only — students&apos; records live in the school&apos;s own portal.
            </p>
            <div className="pa-stat-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))', marginBottom: 0 }}>
              {([
                ['academicSessions', 'Sessions'],
                ['classes', 'Classes'],
                ['subjects', 'Subjects'],
                ['students', 'Students'],
                ['staff', 'Staff'],
              ] as const).map(([key, label]) => (
                <div key={key} className="pa-card" style={{ padding: '14px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--pa-forest)' }}>{school.setup[key]}</div>
                  <div style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--pa-stone-500)', letterSpacing: '.05em', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <section className="pa-card pa-card-pad" id="status-action">
        <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 750, color: 'var(--pa-forest)' }}>
          {suspended ? 'Reactivate this school' : 'Suspend this school'}
        </h2>

        {suspended ? (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--pa-stone-500)', margin: '4px 0 0' }}>
              Reactivating restores sign-in for every active user at the school immediately.
            </p>
            <form action={reactivateSchoolAction} className="pa-status-form">
              <input type="hidden" name="schoolId" value={school.id} />
              <label htmlFor="reactivate-reason">Reason for the record</label>
              <input id="reactivate-reason" name="reason" type="text" className="pa-input" placeholder="e.g. Subscription renewed for the term" minLength={10} required />
              <label className="pa-confirm-row">
                <input type="checkbox" name="confirm" required />
                <span>Confirm reactivation of {school.name}</span>
              </label>
              <button type="submit" className="pa-btn pa-btn--primary">Reactivate school</button>
            </form>
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--pa-stone-500)', margin: '4px 0 0' }}>
              Suspended immediately: every user at {school.name} is signed out on their next
              request and cannot sign in until reactivation. The school&apos;s data is untouched.
            </p>
            <form action={suspendSchoolAction} className="pa-status-form">
              <input type="hidden" name="schoolId" value={school.id} />
              <label htmlFor="suspend-reason">Reason for the record</label>
              <input id="suspend-reason" name="reason" type="text" className="pa-input" placeholder="e.g. Subscription expired at end of term" minLength={10} required />
              <label className="pa-confirm-row">
                <input type="checkbox" name="confirm" required />
                <span>Confirm suspension of {school.name}</span>
              </label>
              <button type="submit" className="pa-btn pa-btn--danger">Suspend school</button>
            </form>
          </>
        )}

        <p style={{ fontSize: 11.5, color: 'var(--pa-stone-400)', marginTop: 16 }}>
          Schools are never deleted from this screen — a school&apos;s history is preserved
          even after it stops using the platform.
        </p>
      </section>
    </div>
  );
}
