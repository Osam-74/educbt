'use client';

import { useActionState, useState } from 'react';
import type { ReactNode } from 'react';
import PendingButton from '@/app/PendingButton';
import { subjectAction, type ActionState } from './actions';

const EMPTY: ActionState = { ok: false, message: '' };

export type ClientSubjectRow = {
  id: number;
  name: string;
  code: string;
  stage: 'both' | 'junior' | 'senior';
  isCompulsory: boolean;
  departmentId: number | null;
  departmentName: string | null;
  teachers: { name: string; classes: string[] }[];
};

type Department = { id: number; name: string };
type Dispatch = (formData: FormData) => void;

const STAGE_OPTIONS = [
  { value: 'both', label: 'Junior and senior' },
  { value: 'junior', label: 'Junior only' },
  { value: 'senior', label: 'Senior only' },
];

const STAGE_LABEL: Record<string, string> = { both: 'Both', junior: 'Junior', senior: 'Senior' };

/**
 * The "load the standard list" card — shown only while the school does not
 * have it. Once the list is in place the card has nothing left to offer, so it
 * goes: leaving the button on a screen that already shows the standard list
 * invites somebody to press it again and wonder what happened.
 */
export function StandardListCard({ activeCount }: { activeCount: number }) {
  const [state, action, pending] = useActionState(subjectAction, EMPTY);

  return (
    <form action={action} className="card sa-card">
      <fieldset disabled={pending}>
        <h2>Standard subject list</h2>
        {activeCount === 0 && (
          <p className="note">
            This school currently has no active subjects. Load the standard list to get
            started — any subject retired earlier will be brought back in place, keeping
            the results already attached to it.
          </p>
        )}
        <p className="muted">
          Replace the list below with the standard NERDC offering — junior and senior
          subjects, cores marked compulsory, senior subjects grouped by department. Codes
          distinguish the levels, so junior Mathematics (MTH-J) and senior General
          Mathematics (MTH) are never confused.
        </p>
        <p className="muted">
          Subjects already carrying results, scores, registrations or questions are{' '}
          <strong>retired, not deleted</strong> — deleting them would make past report
          cards unreadable. Only unused subjects are removed.
        </p>
        <input type="hidden" name="operation" value="refresh" />
        <ConfirmSubmit
          message="Replace the subject list with the standard offering? Subjects already in use will be retired rather than deleted."
          pendingLabel="Loading…"
          className="sa-btn"
        >
          Load standard subject list
        </ConfirmSubmit>
        {state.message && <p className="muted">{state.message}</p>}
      </fieldset>
    </form>
  );
}

/**
 * Add a subject. The code is optional — the first four letters of the name
 * stand in when the school does not choose one.
 */
export function AddSubjectForm({ departments }: { departments: Department[] }) {
  const [state, action, pending] = useActionState(subjectAction, EMPTY);

  return (
    <form action={action} className="card sa-card">
      <h2>Add a subject</h2>
      <fieldset disabled={pending} className="sa-grid">
        <input type="hidden" name="operation" value="save" />

        <div><label htmlFor="subj_name">Subject name *</label>
          <input id="subj_name" name="name" type="text" required maxLength={150} />
        </div>

        <div><label htmlFor="subj_code">Code</label>
          <input id="subj_code" name="code" type="text" placeholder="auto" maxLength={50} />
        </div>

        <div>
          <label htmlFor="subj_stage">Level</label>
          <select id="subj_stage" name="stage" defaultValue="both">
            {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="subj_dept">Department</label>
          <select id="subj_dept" name="departmentId" defaultValue="0">
            <option value="0">None (open to all)</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        <label className="sa-check">
          <input name="is_compulsory" type="checkbox" value="1" /> Every student must offer this
        </label>
      </fieldset>
      <PendingButton pendingLabel="Adding…" className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>
        Add subject
      </PendingButton>
      {state.message && <p className="muted">{state.message}</p>}
    </form>
  );
}

/**
 * The subject table: who teaches what, inline edit (the same handler as
 * creation, so the two cannot drift apart) and remove. Removing a subject
 * that already carries results retires it rather than deleting it, so
 * existing report cards stay readable.
 */
export function SubjectsTable({
  rows,
  departments,
  filters,
}: {
  rows: ClientSubjectRow[];
  departments: Department[];
  filters: { stage: string; assigned: string; departmentId: number };
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [state, action] = useActionState(subjectAction, EMPTY);

  return (
    <section className="card sa-card">
      <h2>Subjects <span className="muted">({rows.length})</span></h2>

      <FilterBar departments={departments} filters={filters} />

      <div className="sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr><th>Subject</th><th>Code</th><th>Level</th><th>Department</th><th>Compulsory</th><th>Taught by</th><th></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted">No subjects match these filters.</td></tr>
            )}
            {rows.map((s) => (
              <Row
                key={s.id}
                subject={s}
                departments={departments}
                editing={editing === s.id}
                onEdit={() => setEditing(editing === s.id ? null : s.id)}
                action={action}
              />
            ))}
          </tbody>
        </table>
      </div>

      {state.message && <p className="muted" style={{ marginTop: 12 }}>{state.message}</p>}
    </section>
  );
}

function Row({
  subject,
  departments,
  editing,
  onEdit,
  action,
}: {
  subject: ClientSubjectRow;
  departments: Department[];
  editing: boolean;
  onEdit: () => void;
  action: Dispatch;
}) {
  return <>
    <tr>
      <td>{subject.name}</td>
      <td><code>{subject.code}</code></td>
      <td>{STAGE_LABEL[subject.stage]}</td>
      <td>{subject.departmentName ?? <span className="muted">—</span>}</td>
      <td>{subject.isCompulsory ? 'Yes' : <span className="muted">No</span>}</td>
      <td>
        {subject.teachers.length === 0
          ? <span className="muted">nobody assigned</span>
          : subject.teachers.map((t) => (
            <div key={t.name} className="sa-sub">
              {t.name} <span className="muted">— {t.classes.join(', ')}</span>
            </div>
          ))}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="sa-btn sa-btn--small" onClick={onEdit}>Edit</button>{' '}
        <form action={action} style={{ display: 'inline' }}>
          <input type="hidden" name="operation" value="delete" />
          <input type="hidden" name="subjectId" value={subject.id} />
          <ConfirmSubmit
            message={`Remove ${subject.name}? If it already carries results or questions it will be retired rather than deleted, so existing records stay readable.`}
            className="sa-btn sa-btn--small sa-btn--danger"
            pendingLabel="Removing…"
          >
            Remove
          </ConfirmSubmit>
        </form>
      </td>
    </tr>

    {editing && (
      <tr className="sa-edit-row">
        <td colSpan={7}>
          <form action={action} className="sa-edit-form">
            <input type="hidden" name="operation" value="save" />
            <input type="hidden" name="subjectId" value={subject.id} />

            <div className="sa-edit-field" style={{ flex: '2 1 220px' }}>
              <label htmlFor={`name-${subject.id}`}>Subject name</label>
              <input id={`name-${subject.id}`} name="name" type="text" defaultValue={subject.name} required maxLength={150} />
            </div>
            {/* Fixed 110px basis, matching the plugin's code input
               (subjects.php:283 style="max-width:110px") — a shrink-only
               max-width inside an auto-fit grid track left dead space
               beside the field; a flex row with a real basis does not. */}
            <div className="sa-edit-field" style={{ flex: '0 0 110px' }}>
              <label htmlFor={`code-${subject.id}`}>Code</label>
              <input id={`code-${subject.id}`} name="code" type="text" defaultValue={subject.code} maxLength={50} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`stage-${subject.id}`}>Level</label>
              <select id={`stage-${subject.id}`} name="stage" defaultValue={subject.stage}>
                {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{STAGE_LABEL[o.value]}</option>)}
              </select>
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`dept-${subject.id}`}>Department</label>
              <select id={`dept-${subject.id}`} name="departmentId" defaultValue={String(subject.departmentId ?? 0)}>
                <option value="0">All / none</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <label className="check">
              <input name="is_compulsory" type="checkbox" value="1" defaultChecked={subject.isCompulsory} /> Compulsory
            </label>
            <PendingButton pendingLabel="Saving…" className="sa-btn sa-btn--primary">Save changes</PendingButton>
          </form>
        </td>
      </tr>
    )}
  </>;
}

/**
 * GET-driven filters, as in the plugin. The department filter only makes sense
 * for senior subjects, so it only appears for the Senior level. Selects
 * submit on change; the Apply button is the no-JavaScript fallback, exactly
 * like the plugin's <noscript> submit.
 */
function FilterBar({
  departments,
  filters,
}: {
  departments: Department[];
  filters: { stage: string; assigned: string; departmentId: number };
}) {
  return (
    <form method="get" className="sa-toolbar">
      <div className="sa-field">
        <label htmlFor="assigned-filter">Assigned</label>
        <select id="assigned-filter" name="assigned" defaultValue={filters.assigned}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="all">All subjects</option>
          <option value="assigned">Has teacher</option>
          <option value="unassigned">No teacher yet</option>
        </select>
      </div>
      <div className="sa-field">
        <label htmlFor="stage-filter">Level</label>
        <select id="stage-filter" name="stage" defaultValue={filters.stage}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="all">All levels</option>
          <option value="junior">Junior</option>
          <option value="senior">Senior</option>
        </select>
      </div>
      {filters.stage === 'senior' && (
        <div className="sa-field">
          <label htmlFor="department-filter">Department</label>
          <select id="department-filter" name="departmentId" defaultValue={String(filters.departmentId)}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            <option value="0">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      )}
      <noscript><button type="submit" className="sa-btn">Apply</button></noscript>
    </form>
  );
}

/** Submit button that confirms before sending, like the plugin's onsubmit dialogs. */
function ConfirmSubmit({
  message,
  className,
  pendingLabel,
  children,
}: {
  message: string;
  className?: string;
  pendingLabel?: string;
  children: ReactNode;
}) {
  return (
    <PendingButton
      className={className}
      pendingLabel={pendingLabel}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </PendingButton>
  );
}
