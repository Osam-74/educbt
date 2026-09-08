'use client';

/**
 * The school-creation form, and the one-time credential handoff.
 *
 * The temporary password exists in exactly one place after creation: the
 * successful action result held in this component's state. It is shown once,
 * with a copy button, and there is deliberately no way to get it back — no
 * "resend", no storage. Once the page is left, it is gone; a forgotten handoff
 * means resetting the principal's password, which is the correct outcome.
 */

import { useActionState } from 'react';
import { createSchoolAction, type OnboardingState } from './actions';

const FIELD_LABELS: Record<string, string> = {
  name: 'School name',
  code: 'School code',
  email: 'Contact email',
  phone: 'Contact phone',
  address: 'Address',
  subdomain: 'Web address',
  status: 'Initial status',
  principalFirstName: 'First name',
  principalLastName: 'Last name',
  principalLoginId: 'Sign-in ID',
};

function FieldError({ field, state }: { field: string; state: OnboardingState }) {
  if (state.status !== 'error') return null;
  const msg = state.fieldErrors?.[field];
  if (!msg) return null;
  return <p className="error" style={{ marginTop: 4 }}>{msg}</p>;
}

export function NewSchoolForm({ loginUrlHint }: { loginUrlHint: string | null }) {
  const [state, formAction, pending] = useActionState(createSchoolAction, {
    status: 'idle',
  } as OnboardingState);

  if (state.status === 'success') {
    const { school, principal, temporaryPassword } = state.result;
    const principalLoginUrl = school.subdomain && loginUrlHint
      ? `https://${school.subdomain}.${loginUrlHint}`
      : null;

    return (
      <section className="card">
        <h2>{school.name} is ready</h2>
        <p>
          The school and its first principal were created together. Give the
          principal these details — they will choose their own password at
          first sign-in.
        </p>

        <div className="facts">
          <div><span>School</span><b>{school.name}</b></div>
          <div><span>School code</span><b className="mono">{school.code}</b></div>
          <div><span>Principal</span><b>{principal.name}</b></div>
          <div><span>Sign-in ID</span><b className="mono">{principal.loginId}</b></div>
          {principalLoginUrl ? (
            <div><span>Sign-in page</span><b className="mono">{principalLoginUrl}</b></div>
          ) : null}
          <div>
            <span>Temporary password</span>
            <b className="mono" data-testid="temp-password">{temporaryPassword}</b>
          </div>
        </div>

        <p className="note" role="alert">
          <strong>Copy this temporary password now. It will not be shown again.</strong>
          {' '}It is not stored anywhere on the platform. If it is lost before the
          principal signs in, their password will have to be reset.
        </p>

        <p style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="copy-btn"
            onClick={() => navigator.clipboard.writeText(temporaryPassword)}
          >
            Copy password
          </button>
          <a href="/platform/schools" className="muted">Back to schools →</a>
        </p>
      </section>
    );
  }

  const err = (f: string) => (state.status === 'error' ? state.fieldErrors?.[f] : undefined);

  return (
    <form action={formAction} className="card" noValidate>
      {state.status === 'error' && Object.keys(state.fieldErrors ?? {}).length === 0 ? (
        <p className="error">{state.message}</p>
      ) : null}
      {state.status === 'error' && Object.keys(state.fieldErrors ?? {}).length > 0 ? (
        <p className="error">{state.message}</p>
      ) : null}

      <h2>The school</h2>

      <label htmlFor="name">School name</label>
      <input id="name" name="name" type="text" placeholder="e.g. Government College, Ilorin" required />
      <FieldError field="name" state={state} />

      <label htmlFor="code">School code</label>
      <input id="code" name="code" type="text" placeholder="e.g. GCI-ILORIN" required />
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
        A unique short name the school will be known by. Letters, numbers and hyphens.
      </p>
      <FieldError field="code" state={state} />

      <label htmlFor="subdomain">Web address (optional)</label>
      <input id="subdomain" name="subdomain" type="text" placeholder="e.g. gci" />
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
        {loginUrlHint
          ? `The school will sign in at <name>.${loginUrlHint}. Set up later if unsure.`
          : 'The school’s own sign-in address. Can be set up later.'}
      </p>
      <FieldError field="subdomain" state={state} />

      <label htmlFor="email">Contact email (optional)</label>
      <input id="email" name="email" type="text" placeholder="e.g. office@gci.edu.ng" />
      <FieldError field="email" state={state} />

      <label htmlFor="phone">Contact phone (optional)</label>
      <input id="phone" name="phone" type="text" placeholder="e.g. 0803 000 0000" />
      <FieldError field="phone" state={state} />

      <label htmlFor="address">Address (optional)</label>
      <input id="address" name="address" type="text" placeholder="Street, town, state" />
      <FieldError field="address" state={state} />

      <label htmlFor="status">Initial status</label>
      <select id="status" name="status" defaultValue="active">
        <option value="active">Active — the school can sign in immediately</option>
        <option value="suspended">Suspended — created but locked until activated</option>
      </select>
      <FieldError field="status" state={state} />

      <h2 style={{ marginTop: 26 }}>The first principal</h2>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        The principal signs in with a temporary password, which they change at
        first sign-in.
      </p>

      <label htmlFor="principalFirstName">First name</label>
      <input id="principalFirstName" name="principalFirstName" type="text" placeholder="e.g. Sarah" required />
      <FieldError field="principalFirstName" state={state} />

      <label htmlFor="principalLastName">Last name</label>
      <input id="principalLastName" name="principalLastName" type="text" placeholder="e.g. Adeyemi" required />
      <FieldError field="principalLastName" state={state} />

      <label htmlFor="principalLoginId">Sign-in ID</label>
      <input id="principalLoginId" name="principalLoginId" type="text" placeholder="e.g. s.adeyemi@gci.edu.ng" required />
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
        What the principal types at sign-in — usually their email address or staff number.
      </p>
      <FieldError field="principalLoginId" state={state} />

      <button type="submit" disabled={pending}>
        {pending ? 'Creating school…' : 'Create school'}
      </button>
    </form>
  );
}
