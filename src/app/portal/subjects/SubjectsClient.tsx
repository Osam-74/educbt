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
    <form action={action} className="card">
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
    <form action={action} className="card">
      <h2>Add a subject</h2>
      <fieldset disabled={pending} className="form-grid">
        <input type="hidden" name="operation" value="save" />

        <label>Subject name *
          <input name="name" type="text" required maxLength={150} />
        </label>

        <label>Code
          <input name="code" type="text" placeholder="auto" maxLength={50} />
        </label>

        <label>Level
          <select name="stage" defaultValue="both">
            {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label>Department
          <select name="departmentId" defaultValue="0">
            <option value="0">None (open to all)</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        <label className="form-check">
          <input name="is_compulsory" type="checkbox" value="1" /> Every student must offer this
        </label>
      </fieldset>
      <PendingButton pendingLabel="Adding…">Add subject</PendingButton>
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
    <section className="card">
      <h2>Subjects <span className="muted">({rows.length})</span></h2>

      <FilterBar departments={departments} filters={filters} />

      <table className="tbl">
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
      <td><strong>{subject.name}</strong></td>
      <td><code>{subject.code}</code></td>
      <td>{STAGE_LABEL[subject.stage]}</td>
      <td>{subject.departmentName ?? <span className="muted">—</span>}</td>
      <td>{subject.isCompulsory ? 'Yes' : <span className="muted">No</span>}</td>
      <td>
        {subject.teachers.length === 0
          ? <span className="muted">nobody assigned</span>
          : subject.teachers.map((t) => (
            <div key={t.name} style={{ fontSize: 13 }}>
              {t.name} <span className="muted">— {t.classes.join(', ')}</span>
            </div>
          ))}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="btn-small" onClick={onEdit}>Edit</button>{' '}
        <form action={action} style={{ display: 'inline' }}>
          <input type="hidden" name="operation" value="delete" />
          <input type="hidden" name="subjectId" value={subject.id} />
          <ConfirmSubmit
            message={`Remove ${subject.name}? If it already carries results or questions it will be retired rather than deleted, so existing records stay readable.`}
            className="btn-small danger"
            pendingLabel="Removing…"
          >
            Remove
          </ConfirmSubmit>
        </form>
      </td>
    </tr>

    {editing && (
      <tr>
        <td colSpan={7} style={{ background: 'var(--wash)' }}>
          <form action={action} className="inline-edit">
            <input type="hidden" name="operation" value="save" />
            <input type="hidden" name="subjectId" value={subject.id} />

            <label>Subject name
              <input name="name" type="text" defaultValue={subject.name} required maxLength={150} />
            </label>
            <label>Code
              <input name="code" type="text" defaultValue={subject.code} maxLength={50} />
            </label>
            <label>Level
              <select name="stage" defaultValue={subject.stage}>
                {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>Department
              <select name="departmentId" defaultValue={String(subject.departmentId ?? 0)}>
                <option value="0">All / none</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="form-check">
              <input name="is_compulsory" type="checkbox" value="1" defaultChecked={subject.isCompulsory} /> Compulsory
            </label>
            <PendingButton pendingLabel="Saving…">Save changes</PendingButton>
          </form>
        </td>
      </tr>
    )}
  </>;
}

/**
 * GET-driven filters, as in the plugin. The department filter only makes sense
 * for senior subjects, so it only appears for the Senior level.
 */
function FilterBar({
  departments,
  filters,
}: {
  departments: Department[];
  filters: { stage: string; assigned: string; departmentId: number };
}) {
  return (
    <div className="filter-bar">
      <form method="get" className="filter-form">
        <select name="assigned" className="filter-select" defaultValue={filters.assigned}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="all">All subjects</option>
          <option value="assigned">Has teacher</option>
          <option value="unassigned">No teacher yet</option>
        </select>
        <select name="stage" className="filter-select" defaultValue={filters.stage}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="all">All levels</option>
          <option value="junior">Junior</option>
          <option value="senior">Senior</option>
        </select>
        {filters.stage === 'senior' && (
          <select name="departmentId" className="filter-select" defaultValue={String(filters.departmentId)}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            <option value="0">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        <button type="submit" className="filter-submit">Filter</button>
      </form>
    </div>
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
