'use client';

import { useActionState, useState } from 'react';
import type { ReactNode } from 'react';
import PendingButton from '@/app/PendingButton';
import { classAction, type ActionState } from './actions';
import type { ClassLevelOption, ClassRow, DepartmentOption } from '@/lib/school/classes';

const EMPTY: ActionState = { ok: false, message: '' };

/**
 * A submit button that confirms first — the plugin's inline
 * `onsubmit="return confirm(…)"`. JavaScript confirm() is synchronous, so the
 * action never even starts unless the school answers yes. Pending feedback
 * comes from the enclosing form (useFormStatus), never from click-time state —
 * mutating state during the click detaches React from the in-flight submit.
 */
function ConfirmSubmit({ message, className, children, pendingLabel }: {
  message: string; className?: string; children: ReactNode; pendingLabel?: string;
}) {
  return (
    <PendingButton
      className={className}
      pendingLabel={pendingLabel}
      onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}
    >
      {children}
    </PendingButton>
  );
}

/**
 * "Create classes" — the plugin's classes.php form: every arm of a level at
 * once, department optional and only meaningful for a senior level.
 */
export function CreateClassesCard({ levels, departments }: {
  levels: ClassLevelOption[];
  departments: DepartmentOption[];
}) {
  const [state, action, pending] = useActionState(classAction, EMPTY);
  const [levelId, setLevelId] = useState('');
  const chosen = levels.find((l) => String(l.id) === levelId);
  // Departments are a senior-school concept (classes.php auto-switches the
  // select to None and disables it for a JSS level).
  const junior = chosen ? chosen.stage !== 'senior' : false;

  return (
    <form action={action} className="card sa-card">
      <fieldset disabled={pending} className="form-grid">
        <h2>Create classes</h2>
        <p className="muted" style={{ marginTop: -6 }}>
          Add every arm of a level at once — type <code>A, B, C</code>. Leave the arms
          box empty if the level has only one class.
        </p>

        <input type="hidden" name="operation" value="create" />

        <label htmlFor="level_id">
          Level <span className="muted">*</span>
          <select
            id="level_id" name="levelId" required value={levelId}
            onChange={(e) => setLevelId(e.target.value)}
          >
            <option value="">Choose a level</option>
            {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>

        <label htmlFor="arms">
          Arms
          <input id="arms" name="arms" type="text" placeholder="A, B, C" />
        </label>

        <label htmlFor="department_id">
          Department
          <select id="department_id" name="departmentId" disabled={junior}>
            <option value="">None</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        <button type="submit" className="sa-btn sa-btn--primary" style={{ justifySelf: 'start' }}>
          Create classes
        </button>
        {state.message && (
          <p className={state.ok ? "note" : "error"} style={{ gridColumn: '1 / -1' }}>{state.message}</p>
        )}
      </fieldset>
    </form>
  );
}

/** One class row plus its hidden edit row — classes.php's `<tr>` pair. */
function ClassRowForm({ row, departments }: { row: ClassRow; departments: DepartmentOption[] }) {
  const [state, action, pending] = useActionState(classAction, EMPTY);
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr data-class-id={row.id}>
        <td><strong>{row.displayName}</strong></td>
        <td>{row.departmentName ?? <span className="muted">—</span>}</td>
        <td>{row.classTeacher ?? <span className="muted">not assigned</span>}</td>
        <td>{row.students}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button type="button" className="sa-btn sa-btn--small" onClick={() => setOpen(!open)}>Edit</button>
        </td>
      </tr>
      {open && (
        <tr className="sa-edit-row" data-for-class={row.id}>
          <td colSpan={5}>
            <form action={action} className="sa-edit-form">
              <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, width: '100%' }}>
                <input type="hidden" name="operation" value="update" />
                <input type="hidden" name="classId" value={row.id} />
                <div className="sa-edit-form--grid" style={{ width: '100%' }}>
                  <label className="sa-edit-field">Arm
                    <input name="arm" type="text" defaultValue={row.arm ?? ''} />
                  </label>
                  <label className="sa-edit-field">Capacity <span className="muted">(0 = no limit)</span>
                    <input name="capacity" type="number" min={0} defaultValue={row.capacity} />
                  </label>
                  <label className="sa-edit-field">Department
                    <select name="departmentId" defaultValue={row.departmentId ?? ''}>
                      <option value="">None</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                  <button type="submit" className="sa-btn sa-btn--primary">Save changes</button>
                </div>
              </fieldset>
            </form>

            <div style={{ borderTop: '1px solid #e2e8e4', paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <form action={action}>
                <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
                  <input type="hidden" name="operation" value="remove" />
                  <input type="hidden" name="classId" value={row.id} />
                  <ConfirmSubmit
                    message="Remove this class?"
                    className="sa-btn sa-btn--danger"
                    pendingLabel="Removing…"
                  >
                    Remove class
                  </ConfirmSubmit>
                </fieldset>
              </form>
              {row.students > 0 && (
                <span className="muted" style={{ fontSize: 12.5 }}>Move the {row.students} student{row.students === 1 ? '' : 's'} out first.</span>
              )}
            </div>

            {state.message && <p className={state.ok ? "note" : "error"} style={{ margin: '10px 0 0' }}>{state.message}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

export function ClassesTable({ rows, departments }: {
  rows: ClassRow[];
  departments: DepartmentOption[];
}) {
  return (
    <section className="card sa-card">
      <h2>Classes <span className="muted">({rows.length})</span></h2>

      {rows.length === 0 ? (
        <p className="sa-empty">No classes yet. Create some above — students cannot be registered until a class exists.</p>
      ) : (
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr><th>Class</th><th>Department</th><th>Class teacher</th><th>Students</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row) => <ClassRowForm key={row.id} row={row} departments={departments} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
