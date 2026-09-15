import { redirect } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { viewPlatformBranding, savePlatformBranding, BrandingError } from '@/lib/platform/branding';
import { PaIcon } from '../icons';

export const dynamic = 'force-dynamic';

/**
 * PLATFORM BRANDING (correction-pass item 6): upload, preview and remove the
 * platform's own logo — the mark rendered in the admin shell header. The
 * same normalizeImage pipeline as a school crest: PNG/JPEG/WebP in, one
 * re-encoded PNG out, DB-backed base64 (no expiring URLs).
 */
export default async function BrandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const actor = await requirePlatformSession();
  const { logoUrl } = await viewPlatformBranding();

  async function upload(formData: FormData) {
    'use server';
    const inner = await requirePlatformSession();
    const logo = formData.get('logo');
    const remove = formData.get('remove') === '1';
    try {
      await savePlatformBranding(inner, {
        logo: logo instanceof File ? logo : null,
        remove,
      });
    } catch (error) {
      const message =
        error instanceof BrandingError ? error.message : 'The logo could not be saved.';
      redirect(`/platform/branding?error=${encodeURIComponent(message)}`);
    }
    redirect('/platform/branding?done=1');
  }

  return (
    <div id="platform-branding-view" style={{ maxWidth: 520, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Branding</h1>
          <p>The platform&rsquo;s own logo, shown in the admin header.</p>
        </div>
      </div>

      {params.error ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 16 }}>
          <PaIcon name="alert" width={15} height={15} />{params.error}
        </div>
      ) : null}
      {params.done ? (
        <div className="pa-alert pa-alert--ok" style={{ marginBottom: 16 }}>
          <PaIcon name="checkCircle" width={15} height={15} />Saved.
        </div>
      ) : null}

      <div className="pa-glass pa-form-card">
        <div className="pa-form-section-head">
          <PaIcon name="spark" width={18} height={18} />
          <h2>Platform logo</h2>
        </div>

        {logoUrl ? (
          <div className="pa-brand-preview" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0' }}>
            <img
              src={logoUrl}
              alt="Platform logo"
              style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 10, background: 'var(--pa-surface, #fff)', padding: 4 }}
            />
            <span className="muted" style={{ fontSize: 13 }}>Current logo</span>
          </div>
        ) : (
          <p className="pa-field-hint">No logo set yet — the header shows the default mark.</p>
        )}

        <form action={upload}>
          <div className="pa-field">
            <label htmlFor="logo">Upload logo</label>
            <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="pa-input" />
            <p className="pa-field-hint">PNG, JPEG or WebP, up to 2 MB. Re-encoded to a compact PNG.</p>
          </div>
          <button type="submit" className="pa-btn pa-btn--primary">{logoUrl ? 'Replace logo' : 'Save logo'}</button>
        </form>

        {logoUrl ? (
          <form action={upload} style={{ marginTop: 10 }}>
            <input type="hidden" name="remove" value="1" />
            <button type="submit" className="pa-btn pa-btn--outline">Remove logo</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
