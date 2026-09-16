'use client';

/**
 * The dashboard's "Start New Session/Term" switcher — the legacy
 * school/index.php modal (#edu-new-term-modal) at visual and behavioural
 * parity: a session dropdown, a term dropdown that follows the chosen
 * session (the plugin pre-loaded the whole session→terms map to avoid
 * AJAX — same trick, carried as props instead of a JSON <script>), and the
 * same copy: switching changes the dashboard for all staff, past question
 * banks remain accessible, previous results are preserved.
 *
 * The submit goes through the settings period action (selectPeriod), which
 * is principal-only on the server — the dashboard renders the button for
 * the principal, everyone else keeps the School Settings link alone.
 */
import { useActionState, useEffect, useRef, useState } from 'react';
import { settingsAction, type SettingsState } from './settings/actions';
import { PortalIcon } from './PortalShell';

const EMPTY: SettingsState = { ok: false, message: '' };

export type DialogSession = { id: number; title: string; isCurrent: boolean };
export type DialogTerm = { id: number; title: string; sessionId: number; position: number; isCurrent: boolean };

export default function NewTermDialog({ sessions, terms, currentSessionId, currentTermId }: {
  sessions: DialogSession[];
  terms: DialogTerm[];
  currentSessionId: number;
  currentTermId: number;
}) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState(currentSessionId || sessions[0]?.id || 0);
  const [termId, setTermId] = useState(currentTermId);
  const [state, action, pending] = useActionState(settingsAction, EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Success closes the modal — the revalidated dashboard underneath shows
  // the new session and term, which is itself the confirmation.
  useEffect(() => {
    if (state.ok) timer.current = setTimeout(() => setOpen(false), 1400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [state]);

  const sessionTerms = terms.filter((t) => t.sessionId === sessionId);

  // Switching session never invents a term: keep the selection only if it
  // belongs to the new session, otherwise fall to that session's first term.
  const chooseSession = (id: number) => {
    setSessionId(id);
    setTermId((current) => terms.some((t) => t.sessionId === id && t.id === current)
      ? current
      : terms.find((t) => t.sessionId === id)?.id ?? 0);
  };

  return <>
    <button type="button" className="sd-action sd-action--term" onClick={() => setOpen(true)}>
      <PortalIcon name="calendar" />Start New Session/Term
    </button>

    {open && (
      <div
        className="sd-modal" role="dialog" aria-modal="true" aria-labelledby="new-term-title"
        onClick={(e) => { if (e.target === e.currentTarget && !pending) setOpen(false); }}
      >
        <div className="sd-modal__card">
          <h3 id="new-term-title">Switch Session / Term</h3>
          <p className="sd-modal__sub">
            This changes the dashboard for all staff. Past question banks remain accessible.
            Results and exams from the previous term are preserved.
          </p>
          <form action={action}>
            <input type="hidden" name="kind" value="period" />
            <input type="hidden" name="payload" value={JSON.stringify({ sessionId, termId })} />

            <label htmlFor="new-session-select">Academic session</label>
            <select id="new-session-select" value={sessionId} onChange={(e) => chooseSession(Number(e.target.value))}>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}{s.isCurrent ? ' · current' : ''}</option>)}
            </select>

            <label htmlFor="new-term-select">Term</label>
            <select id="new-term-select" value={termId} onChange={(e) => setTermId(Number(e.target.value))}>
              {sessionTerms.length === 0 && <option value={0}>No terms in this session yet</option>}
              {sessionTerms.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>

            <div className="sd-modal__row">
              <button type="submit" className="sd-action sd-action--solid" disabled={pending || !sessionId || !termId}>
                {pending ? 'Switching…' : 'Confirm'}
              </button>
              <button type="button" className="sd-action sd-action--ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
            </div>
          </form>

          {state.message && (
            <p className={state.ok ? 'sd-modal__ok' : 'sd-modal__err'} role={state.ok ? 'status' : 'alert'}>
              {state.message}
            </p>
          )}
        </div>
      </div>
    )}
  </>;
}
