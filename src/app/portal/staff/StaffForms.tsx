'use client';

import { useActionState, useState } from 'react';
import { staffAction, type ActionState } from './actions';

const EMPTY: ActionState = { ok: false, message: '' };

export type StaffRow = {
  id: number;
  staffNumber: string;
  title: string | null;
  firstName: string;
  lastName: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  photoUrl: string | null;
  duties: Array<{ id: number; label: string }>;
};

type Option = { id: number; displayName: string };
type SubjectOption = { id: number; name: string; code: string };

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'teacher', label: 'Teacher' },
  { value: 'exam_officer', label: 'Examination Officer' },
  { value: 'vice_principal', label: 'Vice Principal' },
  { value: 'principal', label: 'Principal' },
];

const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

/**
 * Register a staff member. The staff number, login and temporary password are
 * all generated — the office types a name and a role, and hands over the
 * credentials once, in person.
 */
export function RegisterStaffForm() {
  const [state, action, pending] = useActionState(staffAction, EMPTY);

  return (
    <form action={action} className="card sa-card" encType="multipart/form-data">
      <h2>Add a staff member</h2>
      <p className="muted">The staff number, login and a temporary password are generated and shown once. Hand them over in person.</p>

      <fieldset disabled={pending} className="form-grid">
        <input type="hidden" name="operation" value="register" />

        <label>Passport photograph (optional)
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
        </label>

        <label>Title (optional)
          <input name="title" type="text" placeholder="Mr / Mrs / Dr" maxLength={50} />
        </label>

        <label>First name *
          <input name="firstName" type="text" required maxLength={100} />
        </label>

        <label>Surname *
          <input name="lastName" type="text" required maxLength={100} />
        </label>

        <label>Sex (optional)
          <select name="gender" defaultValue="">
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>

        <label>Email (optional)
          <input name="email" type="email" maxLength={191} />
        </label>

        <label>Phone (optional)
          <input name="phone" type="text" maxLength={50} />
        </label>

        <label>Role *
          <select name="role" defaultValue="teacher" required>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>
        {pending ? 'Registering…' : 'Add staff member'}
      </button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
    </form>
  );
}

/**
 * Bulk assignment: one teacher, many classes, many subjects, one save. The
 * legacy form did one pair at a time; an Agricultural Science teacher taking
 * the subject across the whole junior school meant nine separate saves.
 */
export function AssignStaffForm({ classes, subjects, staffOptions }: {
  classes: Option[];
  subjects: SubjectOption[];
  staffOptions: Array<{ id: number; name: string }>;
}) {
  const [state, action, pending] = useActionState(staffAction, EMPTY);

  return (
    <form action={action} className="card sa-card">
      <h2>Assign duties</h2>
      <p className="muted">Class teacher is a duty, not a role: exactly one class teacher per class — assigning a second replaces the first. A subject teacher may take several subjects across several classes in one save.</p>

      <fieldset disabled={pending} className="form-grid">
        <input type="hidden" name="operation" value="assign" />

        <label>Teacher *
          <select name="staffId" required defaultValue="">
            <option value="" disabled>Choose a teacher</option>
            {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <label>Assignment type
          <select name="assignmentType" defaultValue="subject_teacher">
            <option value="subject_teacher">Subject teacher</option>
            <option value="class_teacher">Class teacher (form teacher)</option>
          </select>
        </label>
      </fieldset>

      <fieldset disabled={pending}>
        <legend>Classes</legend>
        <div className="check-grid">
          {classes.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" name="classIds" value={c.id} />
              {c.displayName}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={pending}>
        <legend>Subjects (ignored for class teachers)</legend>
        <div className="check-grid">
          {subjects.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" name="subjectIds" value={s.id} />
              {s.name} <span className="muted">({s.code})</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>
        {pending ? 'Saving…' : 'Save assignments'}
      </button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}

/**
 * One staff row: identity, duties, and the act-on-this-person controls. The
 * edit form (and the stand-down confirmation) live in a wash-background row
 * under the data row — the plugin's hidden-tr pattern, toggled with state
 * instead of a nested <details> inside a table cell.
 */
export function StaffRowForm({ staff }: { staff: StaffRow }) {
  const [state, action, pending] = useActionState(staffAction, EMPTY);
  // 'edit' opens the record form; 'stand-down' opens the confirmation.
  const [panel, setPanel] = useState<'edit' | 'stand-down' | null>(null);
  const inactive = staff.status !== 'active';
  const fullName = `${staff.title ? `${staff.title} ` : ''}${staff.firstName} ${staff.lastName}`;

  // The message row lives UNDER the data row: a failed reset must stay next
  // to the person it concerns, not vanish into the page banner.
  return (
    <>
    <tr className={inactive ? 'row--inactive' : undefined}>
      <td className="mono">{staff.staffNumber}</td>
      <td>
        {staff.photoUrl
          ? <img src={staff.photoUrl} alt="" width={26} height={32} style={{ objectFit: 'cover', borderRadius: 4, marginRight: 8, verticalAlign: 'middle' }} />
          : null}
        {fullName}
      </td>
      <td>{ROLE_LABEL[staff.role] ?? staff.role}</td>
      <td>
        {staff.duties.length === 0
          ? <span className="muted">—</span>
          : staff.duties.map((d) => (
            <div key={d.id} className="sa-sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }}>{d.label}</span>
              <form action={action} className="inline-form">
                <input type="hidden" name="operation" value="drop" />
                <input type="hidden" name="assignmentId" value={d.id} />
                <button type="submit" name="operation" value="drop" disabled={pending} className="sa-btn sa-btn--small sa-btn--danger">Drop</button>
              </form>
            </div>
          ))}
      </td>
      <td><span className={`sa-pill sa-pill--${staff.status}`}>{staff.status}</span></td>
      <td className="row-actions" style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="sa-btn sa-btn--small" onClick={() => setPanel(panel === 'edit' ? null : 'edit')}>
          {panel === 'edit' ? 'Close' : 'Edit'}
        </button>{' '}
        <form action={action} className="inline-form">
          <input type="hidden" name="staffId" value={staff.id} />
          <button type="submit" name="operation" value="reset" disabled={pending} className="sa-btn sa-btn--small">Reset password</button>
        </form>{' '}
        {inactive
          ? (
            <form action={action} className="inline-form">
              <input type="hidden" name="staffId" value={staff.id} />
              <button type="submit" name="operation" value="reactivate" disabled={pending} className="sa-btn sa-btn--small">Reactivate</button>
            </form>
          )
          : (
            <button type="button" className="sa-btn sa-btn--small sa-btn--danger" onClick={() => setPanel(panel === 'stand-down' ? null : 'stand-down')}>
              Stand down…
            </button>
          )}
      </td>
    </tr>

    {panel === 'edit' && (
      <tr className="sa-edit-row">
        <td colSpan={6}>
          <form action={action} encType="multipart/form-data" className="sa-edit-form">
            <input type="hidden" name="operation" value="update" />
            <input type="hidden" name="staffId" value={staff.id} />

            <div className="sa-edit-field">
              <label htmlFor={`title-${staff.id}`}>Title</label>
              <input id={`title-${staff.id}`} name="title" type="text" defaultValue={staff.title ?? ''} maxLength={50} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`fn-${staff.id}`}>First name *</label>
              <input id={`fn-${staff.id}`} name="firstName" type="text" required defaultValue={staff.firstName} maxLength={100} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`ln-${staff.id}`}>Surname *</label>
              <input id={`ln-${staff.id}`} name="lastName" type="text" required defaultValue={staff.lastName} maxLength={100} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`em-${staff.id}`}>Email</label>
              <input id={`em-${staff.id}`} name="email" type="email" defaultValue={staff.email ?? ''} maxLength={191} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`ph-${staff.id}`}>Phone</label>
              <input id={`ph-${staff.id}`} name="phone" type="tel" defaultValue={staff.phone ?? ''} maxLength={50} />
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`role-${staff.id}`}>Role</label>
              <select id={`role-${staff.id}`} name="role" defaultValue={staff.role}>
                {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="sa-edit-field">
              <label htmlFor={`photo-${staff.id}`}>Replace photograph</label>
              <input id={`photo-${staff.id}`} type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
            </div>
            {staff.role !== 'principal' ? (
              <label className="check">
                <input type="checkbox" name="confirmTransfer" />
                Allow transfer of the principal role (the current principal becomes a vice principal)
              </label>
            ) : null}

            <button type="submit" name="operation" value="update" disabled={pending} className="sa-btn sa-btn--primary">
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        </td>
      </tr>
    )}

    {panel === 'stand-down' && (
      <tr className="sa-edit-row">
        <td colSpan={6}>
          <form action={action} className="sa-edit-form">
            <input type="hidden" name="staffId" value={staff.id} />
            <label className="check">
              <input type="checkbox" name="confirmReassign" />
              Release their duties and disable their login
            </label>
            <button type="submit" name="operation" value="stand-down" disabled={pending} className="sa-btn sa-btn--small sa-btn--danger">
              {pending ? 'Standing down…' : 'Confirm stand-down'}
            </button>
          </form>
        </td>
      </tr>
    )}

    {state.message || (state.ok && state.credentials)
      ? (
        <tr className="row--message">
          <td colSpan={6}>
            {state.message
              ? <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>
              : null}
            {state.ok && state.credentials
              ? <p role="status" className="credentials">{state.credentials}</p>
              : null}
          </td>
        </tr>
      )
      : null}
    </>
  );
}
