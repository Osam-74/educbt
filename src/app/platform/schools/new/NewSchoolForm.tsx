'use client';

/**
 * The school-creation form, and the one-time credential handoff.
 *
 * VISUAL REVAMP ONLY: this is the same useActionState + createSchoolAction
 * from before — same field names, same validation, same OnboardingState
 * shape. The temporary password still exists in exactly one place after
 * creation (this component's action-result state), shown once with a copy
 * button, never stored or re-fetched.
 */

import { useActionState, useState } from 'react';
import { createSchoolAction, type OnboardingState } from './actions';
import { PaIcon } from '../../icons';
import { CopyButton } from '../../CopyButton';

function FieldError({ field, state }: { field: string; state: OnboardingState }) {
  if (state.status !== 'error') return null;
  const msg = state.fieldErrors?.[field];
  if (!msg) return null;
  return <p className="pa-field-error">{msg}</p>;
}

export function NewSchoolForm({ loginUrlHint }: { loginUrlHint: string | null }) {
  const [state, formAction, pending] = useActionState(createSchoolAction, {
    status: 'idle',
  } as OnboardingState);
  const [crestPreview, setCrestPreview] = useState<string | null>(null);

  if (state.status === 'success') {
    const { school, principal, temporaryPassword } = state.result;
    const principalLoginUrl = school.subdomain && loginUrlHint
      ? `https://${school.subdomain}.${loginUrlHint}`
      : null;

    return (
      <div id="school-created-success-modal" className="pa-success-card">
        <div className="pa-success-head">
          <div className="pa-success-icon"><PaIcon name="checkCircle" width={26} height={26} /></div>
          <div>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--pa-forest)' }}>
              {school.name} is ready
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--pa-stone-500)' }}>
              The school and its first principal were created together.
            </p>
          </div>
        </div>

        <div className="pa-cred-card">
          <div className="pa-cred-head">
            <span>Principal credentials handover</span>
            <span className="pa-cred-onetime">One-time view</span>
          </div>
          <div className="pa-cred-row"><span>School name</span><strong>{school.name} ({school.code})</strong></div>
          <div className="pa-cred-row"><span>Principal</span><strong>{principal.name}</strong></div>
          <div className="pa-cred-row"><span>Sign-in ID</span><strong style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--pa-lime-300)' }}>{principal.loginId}</strong></div>
          {principalLoginUrl ? (
            <div className="pa-cred-row"><span>Sign-in page</span><strong style={{ fontFamily: 'ui-monospace, monospace' }}>{principalLoginUrl}</strong></div>
          ) : null}
          <div className="pa-cred-row">
            <span>Temporary password</span>
            <div className="pa-cred-password-box">
              <strong data-testid="temp-password">{temporaryPassword}</strong>
              <CopyButton value={temporaryPassword} label="Copy" />
            </div>
          </div>
        </div>

        <p role="alert" style={{ fontSize: 12, color: 'var(--pa-amber-800)', background: 'var(--pa-amber-100)', border: '1px solid #fcd34d', borderRadius: 12, padding: '10px 12px', margin: '16px 0 0' }}>
          <strong>Copy this temporary password now. It will not be shown again.</strong>{' '}
          It is not stored anywhere on the platform. If it is lost before the principal signs in, their password will have to be reset.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18 }}>
          <a href="/platform/schools/new" className="pa-btn pa-btn--ghost">Create another</a>
          <a href="/platform/schools" className="pa-btn pa-btn--primary">
            View in directory <PaIcon name="chevronRight" width={14} height={14} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="pa-glass pa-form-card" noValidate>
      {state.status === 'error' ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 20 }}>
          <PaIcon name="alert" width={16} height={16} />
          {state.message}
        </div>
      ) : null}

      <div className="pa-form-section">
        <div className="pa-form-section-head">
          <PaIcon name="building" width={18} height={18} />
          <h2>The school</h2>
        </div>

        <div className="pa-field">
          <label htmlFor="name">School name <span className="pa-required">*</span></label>
          <input id="name" name="name" type="text" required placeholder="e.g. Government College, Ilorin" className="pa-input" />
          <FieldError field="name" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="code">School code <span className="pa-required">*</span></label>
          <input id="code" name="code" type="text" required placeholder="e.g. GCI-ILORIN" className="pa-input pa-num" style={{ textTransform: 'uppercase' }} />
          <p className="pa-field-hint">A unique short name the school will be known by. Letters, numbers and hyphens.</p>
          <FieldError field="code" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="subdomain">Web address <span className="pa-optional">(optional)</span></label>
          <input id="subdomain" name="subdomain" type="text" placeholder="e.g. gci" className="pa-input pa-num" />
          <p className="pa-field-hint">
            The school will sign in at <code>{loginUrlHint ? '<name>' : '<name>'}.{loginUrlHint ?? 'your-platform-domain'}</code>. Set up later if unsure.
          </p>
          <FieldError field="subdomain" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="crest">School crest <span className="pa-optional">(optional)</span></label>
          <div className="pa-crest-upload">
            <div className="pa-crest-preview">
              {crestPreview ? (
                <img src={crestPreview} alt="Crest preview" />
              ) : (
                <PaIcon name="building" width={20} height={20} />
              )}
            </div>
            <div>
              <input
                id="crest"
                name="crest"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="pa-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) { setCrestPreview(null); return; }
                  const reader = new FileReader();
                  reader.onload = () => setCrestPreview(String(reader.result));
                  reader.readAsDataURL(file);
                }}
              />
              <p className="pa-field-hint">PNG, JPEG or WebP, up to 2&nbsp;MB. Shown beside the school in the directory.</p>
            </div>
          </div>
          <FieldError field="crest" state={state} />
        </div>

        <div className="pa-grid-2">
          <div className="pa-field">
            <label htmlFor="email">Contact email <span className="pa-optional">(optional)</span></label>
            <input id="email" name="email" type="text" placeholder="e.g. office@gci.edu.ng" className="pa-input" />
            <FieldError field="email" state={state} />
          </div>
          <div className="pa-field">
            <label htmlFor="phone">Contact phone <span className="pa-optional">(optional)</span></label>
            <input id="phone" name="phone" type="text" placeholder="e.g. 0803 000 0000" className="pa-input" />
            <FieldError field="phone" state={state} />
          </div>
        </div>

        <div className="pa-field">
          <label htmlFor="address">Address <span className="pa-optional">(optional)</span></label>
          <input id="address" name="address" type="text" placeholder="Street, town, state" className="pa-input" />
          <FieldError field="address" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="status">Initial status</label>
          <select id="status" name="status" defaultValue="active" className="pa-select" style={{ width: '100%' }}>
            <option value="active">Active — the school can sign in immediately</option>
            <option value="suspended">Suspended — created but locked until activated</option>
          </select>
          <FieldError field="status" state={state} />
        </div>
      </div>

      <div className="pa-form-section">
        <div className="pa-form-section-head">
          <PaIcon name="userCheck" width={18} height={18} />
          <h2>The first principal</h2>
        </div>
        <p className="pa-form-section-hint">The principal signs in with a temporary password, which they change at first sign-in.</p>

        <div className="pa-grid-2">
          <div className="pa-field">
            <label htmlFor="principalFirstName">First name <span className="pa-required">*</span></label>
            <input id="principalFirstName" name="principalFirstName" type="text" required placeholder="e.g. Sarah" className="pa-input" />
            <FieldError field="principalFirstName" state={state} />
          </div>
          <div className="pa-field">
            <label htmlFor="principalLastName">Last name <span className="pa-required">*</span></label>
            <input id="principalLastName" name="principalLastName" type="text" required placeholder="e.g. Adeyemi" className="pa-input" />
            <FieldError field="principalLastName" state={state} />
          </div>
        </div>

        <div className="pa-field">
          <label htmlFor="principalLoginId">Sign-in ID <span className="pa-required">*</span></label>
          <input id="principalLoginId" name="principalLoginId" type="text" required placeholder="e.g. s.adeyemi@gci.edu.ng" className="pa-input pa-num" />
          <p className="pa-field-hint">What the principal types at sign-in — usually their email address or staff number.</p>
          <FieldError field="principalLoginId" state={state} />
        </div>
      </div>

      <button type="submit" id="submit-create-school-btn" disabled={pending} className="pa-btn pa-btn--primary">
        {pending ? (
          <>
            <span className="pa-spinner" />
            <span>Creating school…</span>
          </>
        ) : (
          <span>Create school</span>
        )}
      </button>
    </form>
  );
}
