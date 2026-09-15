'use client';

/**
 * Edit School — name, contact, address, web address and crest only. There is
 * no code/id field anywhere in this form (nothing to disable-and-hide — it's
 * simply not present), and no status control (suspend/reactivate keeps its
 * own reasoned, confirmed flow on the school's detail page).
 */

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateSchoolAction, type EditSchoolState } from './actions';
import { PaIcon } from '../../../icons';

function FieldError({ field, state }: { field: string; state: EditSchoolState }) {
  if (state.status !== 'error') return null;
  const msg = state.fieldErrors?.[field];
  if (!msg) return null;
  return <p className="pa-field-error">{msg}</p>;
}

export type EditableSchool = {
  id: number;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  subdomain: string | null;
  logoUrl: string | null;
};

export function EditSchoolForm({ school, loginUrlHint }: { school: EditableSchool; loginUrlHint: string | null }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(updateSchoolAction, { status: 'idle' } as EditSchoolState);
  const [crestPreview, setCrestPreview] = useState<string | null>(school.logoUrl);
  const [removeCrest, setRemoveCrest] = useState(false);

  if (state.status === 'success') {
    return (
      <div className="pa-glass pa-form-card" id="school-updated-success-card">
        <div className="pa-success-head">
          <div className="pa-success-icon"><PaIcon name="checkCircle" width={26} height={26} /></div>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--pa-forest)' }}>{state.name} updated</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--pa-stone-500)' }}>Changes are live across the directory and dashboard.</p>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18 }}>
          <a href={`/platform/schools/${school.id}`} className="pa-btn pa-btn--ghost">Back to school</a>
          <a href="/platform/schools" className="pa-btn pa-btn--primary">
            View in directory <PaIcon name="chevronRight" width={14} height={14} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="pa-glass pa-form-card" noValidate>
      <input type="hidden" name="schoolId" value={school.id} />

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
          <label>School code</label>
          <input value={school.code} disabled className="pa-input pa-num" style={{ opacity: 0.65, cursor: 'not-allowed' }} />
          <p className="pa-field-hint">The internal identifier — set once at creation and never edited here.</p>
        </div>

        <div className="pa-field">
          <label htmlFor="name">School name <span className="pa-required">*</span></label>
          <input id="name" name="name" type="text" required defaultValue={school.name} className="pa-input" />
          <FieldError field="name" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="subdomain">Web address <span className="pa-optional">(optional)</span></label>
          <input id="subdomain" name="subdomain" type="text" defaultValue={school.subdomain ?? ''} className="pa-input pa-num" />
          <p className="pa-field-hint">
            The school signs in at <code>&lt;name&gt;.{loginUrlHint ?? 'your-platform-domain'}</code>.
          </p>
          <FieldError field="subdomain" state={state} />
        </div>

        <div className="pa-field">
          <label htmlFor="crest">School crest <span className="pa-optional">(optional)</span></label>
          <div className="pa-crest-upload">
            <div className="pa-crest-preview">
              {crestPreview && !removeCrest ? (
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
                  if (!file) return;
                  setRemoveCrest(false);
                  const reader = new FileReader();
                  reader.onload = () => setCrestPreview(String(reader.result));
                  reader.readAsDataURL(file);
                }}
              />
              <p className="pa-field-hint">PNG, JPEG or WebP, up to 2&nbsp;MB. Uploading a new one replaces the current crest.</p>
              {school.logoUrl ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--pa-stone-600)', marginTop: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    name="removeCrest"
                    checked={removeCrest}
                    onChange={(e) => { setRemoveCrest(e.target.checked); if (e.target.checked) setCrestPreview(null); else setCrestPreview(school.logoUrl); }}
                  />
                  Remove current crest
                </label>
              ) : null}
            </div>
          </div>
          <FieldError field="crest" state={state} />
        </div>

        <div className="pa-grid-2">
          <div className="pa-field">
            <label htmlFor="email">Contact email <span className="pa-optional">(optional)</span></label>
            <input id="email" name="email" type="text" defaultValue={school.email ?? ''} className="pa-input" />
            <FieldError field="email" state={state} />
          </div>
          <div className="pa-field">
            <label htmlFor="phone">Contact phone <span className="pa-optional">(optional)</span></label>
            <input id="phone" name="phone" type="text" defaultValue={school.phone ?? ''} className="pa-input" />
            <FieldError field="phone" state={state} />
          </div>
        </div>

        <div className="pa-field">
          <label htmlFor="address">Address <span className="pa-optional">(optional)</span></label>
          <input id="address" name="address" type="text" defaultValue={school.address ?? ''} className="pa-input" />
          <FieldError field="address" state={state} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="pa-btn pa-btn--ghost" onClick={() => router.back()} disabled={pending}>Cancel</button>
        <button type="submit" className="pa-btn pa-btn--primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
