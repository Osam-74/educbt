'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { studentAction, type ActionState } from './actions';

const EMPTY: ActionState = { ok: false, message: '' };

type ClassOption = { id: number; displayName: string };

const CONFIRMS = {
  approve: 'Approve this student? They will be activated and enrolled.',
  reset: 'Reset this password to the student\'s surname?',
  withdraw: 'Withdraw this student? Their results are kept. Use when they leave the school.',
  reinstate: 'Reactivate this withdrawn student?',
  reactivate: 'Reactivate this student? They will regain portal access.',
  deactivate: 'Deactivate this student? They will lose portal access until reactivated. Use for suspension, unpaid fees, etc.',
};

function confirmSubmit(message: string) {
  return (e: React.MouseEvent) => { if (!window.confirm(message)) e.preventDefault(); };
}

/** Live passport preview — the plugin's educbtPreviewStudentPhoto. */
function usePhotoPreview() {
  const [src, setSrc] = useState<string | null>(null);
  const onFile = (file: File | undefined) => {
    if (!file) { setSrc(null); return; }
    const reader = new FileReader();
    reader.onload = (e) => setSrc(e.target?.result as string);
    reader.readAsDataURL(file);
  };
  return { src, onFile };
}

/** A select that submits its own form on change — the plugin's
 *  `onchange="this.form.submit()"` filter selects. */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      onChange={(e) => { props.onChange?.(e); e.currentTarget.form?.requestSubmit(); }}
    />
  );
}

/**
 * Register a student — the plugin's card exactly: passport photograph first
 * (the thing the office has in their hand at intake), then the identity grid
 * in the plugin's order, guardian details folded into a details block.
 */
export function RegisterStudentForm({ classes, teacher }: { classes: ClassOption[]; teacher: boolean }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);
  const preview = usePhotoPreview();

  return (
    <form action={action} encType="multipart/form-data" className="card sa-card">
      <p className="muted" style={{ marginTop: -6 }}>
        The admission number and first password are generated automatically.
      </p>

      <fieldset disabled={pending}>
        <input type="hidden" name="operation" value="register" />

        <div style={{ marginBottom: 16 }}>
          <label htmlFor="reg-photo">Passport photograph</label>
          <input
            id="reg-photo" type="file" name="photo" accept="image/jpeg,image/png,image/webp"
            onChange={(e) => preview.onFile(e.target.files?.[0])}
          />
          {preview.src && (
            <div style={{ marginTop: 8 }}>
              <img src={preview.src} alt="" style={{ maxWidth: 80, maxHeight: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid #ccc' }} />
            </div>
          )}
        </div>

        <div className="sa-grid">
          <div>
            <label htmlFor="reg-admission">Student ID</label>
            <input id="reg-admission" name="admissionNumber" type="text" placeholder="Leave blank to generate one" maxLength={50} />
          </div>
          <div>
            <label htmlFor="reg-first">First name *</label>
            <input id="reg-first" name="firstName" type="text" required maxLength={100} />
          </div>
          <div>
            <label htmlFor="reg-last">Surname *</label>
            <input id="reg-last" name="lastName" type="text" required maxLength={100} />
          </div>
          <div>
            <label htmlFor="reg-sex">Sex</label>
            <select id="reg-sex" name="gender" defaultValue="">
              <option value="">—</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <div>
            <label htmlFor="reg-dob">Date of birth</label>
            <input id="reg-dob" name="dateOfBirth" type="date" />
          </div>
          <div>
            <label htmlFor="reg-class">Class *</label>
            <select id="reg-class" name="classId" required defaultValue="">
              <option value="" disabled>Choose a class</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>
          </div>
        </div>

        <details style={{ marginTop: 14 }}>
          <summary>Parent / guardian details (optional)</summary>
          <p className="muted">Adding these now sends the parent an invitation to create their own portal account.</p>
          <div className="sa-grid">
            <div><label htmlFor="reg-gfirst">Guardian first name</label><input id="reg-gfirst" name="guardianFirstName" type="text" maxLength={100} /></div>
            <div><label htmlFor="reg-glast">Guardian surname</label><input id="reg-glast" name="guardianLastName" type="text" maxLength={100} /></div>
            <div><label htmlFor="reg-gemail">Guardian email</label><input id="reg-gemail" name="guardianEmail" type="email" maxLength={191} /></div>
            <div><label htmlFor="reg-gphone">Guardian phone</label><input id="reg-gphone" name="guardianPhone" type="tel" maxLength={50} /></div>
          </div>
        </details>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>
        {pending ? 'Registering…' : 'Register student'}
      </button>
      {teacher && <p className="muted">You are a class teacher: the record is created and placed in your class, but stays pending until the office approves it.</p>}

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
      {state.ok && state.invite && <p role="status" className="credentials">{state.invite}</p>}
    </form>
  );
}

/**
 * Import many students — the plugin's second collapsed section: download the
 * four-column template, choose a class, upload the filled CSV. IDs and
 * passwords are generated; per-row failures are reported, not skipped.
 */
export function ImportStudentsForm({ classes }: { classes: ClassOption[] }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} encType="multipart/form-data" className="card sa-card">
      <p className="muted" style={{ marginTop: -6 }}>
        Download the template, fill it in, upload it back. Only four columns:
        <code>first_name</code>, <code>last_name</code>, <code>gender</code>, <code>date_of_birth</code>.
        Admission numbers and passwords are generated — do not add them.
      </p>

      <fieldset disabled={pending}>
        <a className="sa-btn" href="/portal/students/template.csv" style={{ display: 'inline-block', marginBottom: 14 }}>
          Download template
        </a>

        <input type="hidden" name="operation" value="import" />
        <div className="sa-grid">
          <div>
            <label htmlFor="import-class">Into class *</label>
            <select id="import-class" name="classId" required defaultValue="">
              <option value="" disabled>Choose a class</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="import-csv">CSV file *</label>
            <input id="import-csv" name="csv" type="file" accept=".csv,text/csv" required />
          </div>
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 14 }}>
        {pending ? 'Importing…' : 'Import students'}
      </button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
    </form>
  );
}

const STATUS_PILL: Record<string, { label: string; pill: string }> = {
  active: { label: 'Active', pill: 'sa-pill--active' },
  pending_approval: { label: 'Pending', pill: 'sa-pill--draft' },
  suspended: { label: 'Suspended', pill: 'sa-pill--suspended' },
  withdrawn: { label: 'Withdrawn', pill: 'sa-pill--withdrawn' },
  expelled: { label: 'Expelled', pill: 'sa-pill--withdrawn' },
  graduated: { label: 'Graduated', pill: 'sa-pill--graduated' },
};

/**
 * One student row — the plugin's table exactly: admission number, name with
 * passport thumbnail, class, status pill, and an Edit toggle (plus Approve for
 * pending records). The hidden row underneath carries the edit form, the
 * password reset and the standing buttons — every act-on-this-student
 * control lives inside that row, as in the plugin.
 */
export function StudentRowForm({ student, classes, office }: {
  student: {
    id: number; admissionNumber: string; firstName: string; lastName: string;
    gender: string | null;
    status: string; className: string | null; photoUrl: string | null;
    parentName: string | null; parentPhone: string | null; parentEmail: string | null;
    address: string | null; classId: number | null;
  };
  classes: ClassOption[];
  office: boolean;
}) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);
  const [open, setOpen] = useState(false);
  const preview = usePhotoPreview();
  const standing = STATUS_PILL[student.status] ?? { label: student.status, pill: '' };
  const name = `${student.firstName} ${student.lastName}`;

  return (
    <>
      <tr className={student.status !== 'active' && student.status !== 'pending_approval' ? 'row--inactive' : undefined}>
        <td><code>{student.admissionNumber}</code></td>
        <td>
          {student.photoUrl
            ? <img src={student.photoUrl} alt="" style={{ width: 26, height: 32, objectFit: 'cover', borderRadius: 4, verticalAlign: 'middle', marginRight: 7 }} />
            : null}
          {name}
        </td>
        <td>{student.className ?? <span className="muted">Unenrolled</span>}</td>
        <td><span className={`sa-pill ${standing.pill}`}>{standing.label}</span></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {office && student.status === 'pending_approval' && (
            <form action={action} className="inline-form" style={{ display: 'inline' }}>
              <input type="hidden" name="operation" value="approve" />
              <input type="hidden" name="studentId" value={student.id} />
              <button type="submit" disabled={pending} className="sa-btn sa-btn--small sa-btn--primary" onClick={confirmSubmit(CONFIRMS.approve)}>Approve</button>
            </form>
          )}
          <button type="button" className="sa-btn sa-btn--small" onClick={() => setOpen(!open)}>Edit</button>
          <Link href={`/portal/students/${student.id}`} className="sa-btn sa-btn--small sa-btn--primary" style={{ marginLeft: 6 }}>View</Link>
        </td>
      </tr>

      {open && (
        <tr className="sa-edit-row">
          <td colSpan={5} style={{ background: '#f5f7f6' }}>
            <form action={action} encType="multipart/form-data" style={{ padding: '12px 0' }}>
              <input type="hidden" name="operation" value="update" />
              <input type="hidden" name="studentId" value={student.id} />

              <div style={{ marginBottom: 12 }}>
                <label htmlFor={`photo-${student.id}`}>Passport photograph</label>
                {student.photoUrl && (
                  <div style={{ marginBottom: 6 }}>
                    <img src={student.photoUrl} alt="" style={{ maxWidth: 60, maxHeight: 75, objectFit: 'cover', borderRadius: 6, border: '1px solid #ccc' }} />
                  </div>
                )}
                <input
                  id={`photo-${student.id}`} type="file" name="photo" accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => preview.onFile(e.target.files?.[0])}
                />
                {preview.src && (
                  <div style={{ marginTop: 8 }}>
                    <img src={preview.src} alt="" style={{ maxWidth: 60, maxHeight: 75, objectFit: 'cover', borderRadius: 6, border: '1px solid #ccc' }} />
                  </div>
                )}
              </div>

              <div className="sa-grid">
                <div>
                  <label htmlFor={`an-${student.id}`}>Student ID</label>
                  <input id={`an-${student.id}`} name="admissionNumber" type="text" defaultValue={student.admissionNumber} maxLength={50} />
                  <small className="muted">This is also the student&apos;s login username.</small>
                </div>
                <div><label htmlFor={`fn-${student.id}`}>First name *</label><input id={`fn-${student.id}`} name="firstName" type="text" required defaultValue={student.firstName} maxLength={100} /></div>
                <div><label htmlFor={`ln-${student.id}`}>Surname *</label><input id={`ln-${student.id}`} name="lastName" type="text" required defaultValue={student.lastName} maxLength={100} /></div>
                <div>
                  <label htmlFor={`sx-${student.id}`}>Sex</label>
                  <select id={`sx-${student.id}`} name="gender" defaultValue={student.gender ?? ''}>
                    <option value="">—</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`mv-${student.id}`}>Move to class</label>
                  <select id={`mv-${student.id}`} name="classId" defaultValue={student.classId ?? ''}>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                  </select>
                </div>
              </div>

              <div className="sa-grid" style={{ marginTop: 12 }}>
                <div><label htmlFor={`pn-${student.id}`}>Parent / Guardian name</label><input id={`pn-${student.id}`} name="parentName" type="text" defaultValue={student.parentName ?? ''} maxLength={191} /></div>
                <div><label htmlFor={`pp-${student.id}`}>Parent phone</label><input id={`pp-${student.id}`} name="parentPhone" type="tel" defaultValue={student.parentPhone ?? ''} maxLength={50} /></div>
                <div><label htmlFor={`pe-${student.id}`}>Parent email</label><input id={`pe-${student.id}`} name="parentEmail" type="email" defaultValue={student.parentEmail ?? ''} maxLength={191} /></div>
              </div>
              <label htmlFor={`ad-${student.id}`} style={{ marginTop: 8 }}>Address</label>
              <textarea id={`ad-${student.id}`} name="address" rows={2} defaultValue={student.address ?? ''} style={{ width: '100%', padding: '9px 12px', border: '1px solid #d7dedb', borderRadius: 9, font: 'inherit', fontSize: 14 }} />

              <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 12 }}>
                {pending ? 'Saving…' : 'Save changes'}
              </button>
            </form>

            <div style={{ borderTop: '1px solid #e2e8e4', paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <form action={action} className="inline-form">
                <input type="hidden" name="operation" value="reset" />
                <input type="hidden" name="studentId" value={student.id} />
                <button type="submit" disabled={pending} className="sa-btn" onClick={confirmSubmit(CONFIRMS.reset)}>Reset password</button>
              </form>

              {office && (
                <>
                  {student.status === 'withdrawn' ? (
                    <form action={action} className="inline-form">
                      <input type="hidden" name="operation" value="standing" />
                      <input type="hidden" name="studentId" value={student.id} />
                      <input type="hidden" name="standing" value="active" />
                      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" onClick={confirmSubmit(CONFIRMS.reinstate)}>Reinstate</button>
                    </form>
                  ) : student.status === 'suspended' ? (
                    <form action={action} className="inline-form">
                      <input type="hidden" name="operation" value="standing" />
                      <input type="hidden" name="studentId" value={student.id} />
                      <input type="hidden" name="standing" value="active" />
                      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" onClick={confirmSubmit(CONFIRMS.reactivate)}>Reactivate</button>
                    </form>
                  ) : student.status === 'active' && (
                    <form action={action} className="inline-form">
                      <input type="hidden" name="operation" value="standing" />
                      <input type="hidden" name="studentId" value={student.id} />
                      <input type="hidden" name="standing" value="suspended" />
                      <button type="submit" disabled={pending} className="sa-btn" style={{ color: '#92400e', borderColor: '#fcd34d' }} onClick={confirmSubmit(CONFIRMS.deactivate)}>Deactivate</button>
                    </form>
                  )}
                  {student.status !== 'withdrawn' && (
                    <form action={action} className="inline-form">
                      <input type="hidden" name="operation" value="standing" />
                      <input type="hidden" name="studentId" value={student.id} />
                      <input type="hidden" name="standing" value="withdrawn" />
                      <button type="submit" disabled={pending} className="sa-btn sa-btn--danger" onClick={confirmSubmit(CONFIRMS.withdraw)}>Withdraw</button>
                    </form>
                  )}
                </>
              )}
            </div>

            {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'} style={{ marginTop: 10 }}>{state.message}</p>}
            {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

/** Edit form on the student profile: identity, photo, ID, current class —
 *  now with the parent block and address, as the plugin's edit row. */
export function EditStudentForm({ student, classes }: {
  student: {
    id: number; firstName: string; lastName: string; gender: string | null;
    dateOfBirth: string | null; admissionNumber: string; classId: number | null;
    parentName: string | null; parentPhone: string | null; parentEmail: string | null;
    address: string | null;
  };
  classes: ClassOption[];
}) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);
  const preview = usePhotoPreview();

  return (
    <form action={action} encType="multipart/form-data" className="sa-edit-form">
      <input type="hidden" name="operation" value="update" />
      <input type="hidden" name="studentId" value={student.id} />

      <div style={{ marginBottom: 12 }}>
        <label>Passport photograph</label>
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" onChange={(e) => preview.onFile(e.target.files?.[0])} />
        {preview.src && (
          <div style={{ marginTop: 8 }}>
            <img src={preview.src} alt="" style={{ maxWidth: 60, maxHeight: 75, objectFit: 'cover', borderRadius: 6, border: '1px solid #ccc' }} />
          </div>
        )}
      </div>

      <fieldset disabled={pending} className="sa-grid">
        <div>
          <label htmlFor="e-an">Student ID</label>
          <input id="e-an" name="admissionNumber" type="text" defaultValue={student.admissionNumber} maxLength={50} />
          <small className="muted">This is also the student&apos;s login username.</small>
        </div>
        <div><label htmlFor="e-fn">First name *</label><input id="e-fn" name="firstName" type="text" required defaultValue={student.firstName} maxLength={100} /></div>
        <div><label htmlFor="e-ln">Surname *</label><input id="e-ln" name="lastName" type="text" required defaultValue={student.lastName} maxLength={100} /></div>
        <div>
          <label htmlFor="e-sx">Sex</label>
          <select id="e-sx" name="gender" defaultValue={student.gender ?? ''}>
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </div>
        <div><label htmlFor="e-dob">Date of birth</label><input id="e-dob" name="dateOfBirth" type="date" defaultValue={student.dateOfBirth ?? ''} /></div>
        <div>
          <label htmlFor="e-cl">Move to class</label>
          <select id="e-cl" name="classId" defaultValue={student.classId ?? ''}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
        </div>
        <div><label htmlFor="e-pn">Parent / Guardian name</label><input id="e-pn" name="parentName" type="text" defaultValue={student.parentName ?? ''} maxLength={191} /></div>
        <div><label htmlFor="e-pp">Parent phone</label><input id="e-pp" name="parentPhone" type="tel" defaultValue={student.parentPhone ?? ''} maxLength={50} /></div>
        <div><label htmlFor="e-pe">Parent email</label><input id="e-pe" name="parentEmail" type="email" defaultValue={student.parentEmail ?? ''} maxLength={191} /></div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="e-ad">Address</label>
          <textarea id="e-ad" name="address" rows={2} defaultValue={student.address ?? ''} style={{ width: '100%', padding: '9px 12px', border: '1px solid #d7dedb', borderRadius: 9, font: 'inherit', fontSize: 14 }} />
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary">{pending ? 'Saving…' : 'Save changes'}</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}

/** Standing: one decision, mutually exclusive by construction. */
export function StandingForm({ studentId, status }: { studentId: number; status: string }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} className="inline-edit">
      <input type="hidden" name="operation" value="standing" />
      <input type="hidden" name="studentId" value={studentId} />

      <p className="muted">
        Withdrawn and expelled disable the login and end the current enrolment; suspended keeps the class place.
        Nothing is deleted — a leaver&apos;s record stays for transcripts.
      </p>

      <div className="check-grid">
        {(['active', 'suspended', 'withdrawn', 'expelled'] as const).map((s) => (
          <label key={s} className="check">
            <input type="radio" name="standing" value={s} defaultChecked={status === s} />
            {s[0]!.toUpperCase() + s.slice(1)}
          </label>
        ))}
      </div>

      <button type="submit" disabled={pending} className="sa-btn">Apply standing</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}

/** Office-only: hand a locked-out guardian a one-time temporary password. */
export function GuardianResetForm({ guardianId, guardianName }: { guardianId: number; guardianName: string }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="operation" value="reset-guardian" />
      <input type="hidden" name="guardianId" value={guardianId} />
      <button type="submit" disabled={pending} className="sa-btn sa-btn--small" title={`Issue a temporary password to ${guardianName}`}>
        {pending ? 'Resetting…' : 'Reset login'}
      </button>
      {state.message && !state.ok && (
        <p role="alert" className="error">{state.message}</p>
      )}
      {state.ok && state.credentials && (
        <p role="status" className="credentials">{state.credentials}</p>
      )}
    </form>
  );
}

export function GuardianForm({ studentId }: { studentId: number }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} className="inline-edit">
      <input type="hidden" name="operation" value="link-guardian" />
      <input type="hidden" name="studentId" value={studentId} />

      <fieldset disabled={pending} className="form-grid">
        <label>Full name *
          <input name="guardianFullName" type="text" required maxLength={150} />
        </label>
        <label>Email
          <input name="guardianEmail" type="email" maxLength={191} />
        </label>
        <label>Phone
          <input name="guardianPhone" type="tel" maxLength={50} />
        </label>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary">{pending ? 'Linking…' : 'Link guardian'}</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.invite && <p role="status" className="credentials">{state.invite}</p>}
    </form>
  );
}

/**
 * Subject registration: compulsory subjects are shown but locked (they are
 * registered automatically); electives are the choice. Anything with existing
 * marks this session is pinned — it cannot be dropped mid-term.
 */
export function SubjectRegistrationForm({ studentId, core, electives, registeredIds, protectedIds }: {
  studentId: number;
  core: Array<{ id: number; name: string; code: string }>;
  electives: Array<{ id: number; name: string; code: string }>;
  registeredIds: number[];
  protectedIds: number[];
}) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);
  const registered = new Set(registeredIds);
  const pinned = new Set(protectedIds);

  return (
    <form action={action} className="inline-edit">
      <input type="hidden" name="operation" value="register-subjects" />
      <input type="hidden" name="studentId" value={studentId} />

      <fieldset disabled={pending}>
        <legend>Compulsory subjects (always registered)</legend>
        <div className="check-grid">
          {core.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked disabled />
              {s.name} <span className="muted">({s.code})</span>
            </label>
          ))}
          {core.length === 0 && <p className="muted">No compulsory subjects configured yet.</p>}
        </div>
      </fieldset>

      <fieldset disabled={pending}>
        <legend>Electives</legend>
        <div className="check-grid">
          {electives.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                name="electiveIds"
                value={s.id}
                defaultChecked={registered.has(s.id)}
                disabled={pinned.has(s.id)}
              />
              {s.name} <span className="muted">({s.code})</span>
              {pinned.has(s.id) && <span className="muted">· has marks, cannot be dropped</span>}
            </label>
          ))}
          {electives.length === 0 && <p className="muted">No electives offered yet.</p>}
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary">{pending ? 'Saving…' : 'Save registration'}</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}
