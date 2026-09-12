'use client';

import { useActionState } from 'react';
import { studentAction, type ActionState } from './actions';

const EMPTY: ActionState = { ok: false, message: '' };

type ClassOption = { id: number; displayName: string };

/**
 * Enrol a student. Everything the school types on paper at intake: identity,
 * the class they walk into, and optionally the parent standing next to them.
 * The admission number and the login's initial password are produced by the
 * service and shown once.
 */
export function RegisterStudentForm({ classes, teacher }: { classes: ClassOption[]; teacher: boolean }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} className="card" encType="multipart/form-data">
      <h2>Enrol a student</h2>
      <p className="muted">
        The admission number ({teacher ? '' : 'or type the school\'s own ID — '}blank generates one) doubles as the
        login username; the initial password is the surname, changed at first sign-in.
      </p>

      <fieldset disabled={pending} className="form-grid">
        <input type="hidden" name="operation" value="register" />

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

        <label>Date of birth (optional)
          <input name="dateOfBirth" type="date" />
        </label>

        <label>Student ID (optional — leave blank to generate)
          <input name="admissionNumber" type="text" maxLength={50} placeholder="e.g. SCH/2026/0042" />
        </label>

        <label>Class *
          <select name="classId" required defaultValue="">
            <option value="" disabled>Choose a class</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
        </label>

        <label>Passport photograph (optional)
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
        </label>
      </fieldset>

      <fieldset disabled={pending}>
        <legend>Guardian (optional — the parent is often standing right here)</legend>
        <div className="form-grid">
          <label>Full name
            <input name="guardianFullName" type="text" maxLength={150} />
          </label>
          <label>Email
            <input name="guardianEmail" type="email" maxLength={191} />
          </label>
          <label>Phone
            <input name="guardianPhone" type="text" maxLength={50} />
          </label>
        </div>
        <p className="muted">The guardian is created (or found by email/phone) and linked; their account is activated with an invitation token, never a school-chosen password.</p>
      </fieldset>

      <button type="submit" disabled={pending}>{pending ? 'Enrolling…' : 'Enrol student'}</button>
      {teacher && <p className="muted">You are a class teacher: the record is created and placed in your class, but stays pending until the office approves it.</p>}

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
      {state.ok && state.invite && <p role="status" className="credentials">{state.invite}</p>}
    </form>
  );
}

/** In-row actions for the students list. */
export function StudentRowActions({ studentId, status, office }: { studentId: number; status: string; office: boolean }) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <>
      <form action={action} className="inline-form">
        <input type="hidden" name="operation" value="reset" />
        <input type="hidden" name="studentId" value={studentId} />
        <button type="submit" disabled={pending} className="btn-small">Reset password</button>
      </form>

      {office && status === 'pending_approval' && (
        <form action={action} className="inline-form">
          <input type="hidden" name="operation" value="approve" />
          <input type="hidden" name="studentId" value={studentId} />
          <button type="submit" disabled={pending} className="btn-small">Approve</button>
        </form>
      )}

      {state.message && (
        <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>
      )}
      {state.ok && state.credentials && (
        <p role="status" className="credentials">{state.credentials}</p>
      )}
    </>
  );
}

/** Edit form on the student profile: identity, photo, ID, current class. */
export function EditStudentForm({ student, classes }: {
  student: {
    id: number; firstName: string; lastName: string; gender: string | null;
    dateOfBirth: string | null; admissionNumber: string; classId: number | null;
  };
  classes: ClassOption[];
}) {
  const [state, action, pending] = useActionState(studentAction, EMPTY);

  return (
    <form action={action} className="inline-edit" encType="multipart/form-data">
      <input type="hidden" name="operation" value="update" />
      <input type="hidden" name="studentId" value={student.id} />

      <fieldset disabled={pending} className="form-grid">
        <label>First name *
          <input name="firstName" type="text" required defaultValue={student.firstName} maxLength={100} />
        </label>
        <label>Surname *
          <input name="lastName" type="text" required defaultValue={student.lastName} maxLength={100} />
        </label>
        <label>Sex
          <select name="gender" defaultValue={student.gender ?? ''}>
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>
        <label>Date of birth
          <input name="dateOfBirth" type="date" defaultValue={student.dateOfBirth ?? ''} />
        </label>
        <label>Student ID (changing it moves the login)
          <input name="admissionNumber" type="text" defaultValue={student.admissionNumber} maxLength={50} />
        </label>
        <label>Class (moves this session only)
          <select name="classId" defaultValue={student.classId ?? ''}>
            <option value="">— no class —</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
        </label>
        <label>Replace photograph
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
        </label>
      </fieldset>

      <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button>

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

      <button type="submit" disabled={pending} className="btn-small">Apply standing</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}

/** Link a guardian by invite: created on first sight, deduplicated by contact. */
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
          <input name="guardianPhone" type="text" maxLength={50} />
        </label>
        <label>Relationship
          <select name="relationship" defaultValue="parent">
            <option value="parent">Parent</option>
            <option value="mother">Mother</option>
            <option value="father">Father</option>
            <option value="guardian">Guardian</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" name="canViewResults" defaultChecked />
          May view this student&apos;s results
        </label>
      </fieldset>
      <p className="muted">An email or a phone is required — the guardian activates their own account with the invitation token, so no password is ever chosen for them.</p>

      <button type="submit" disabled={pending}>{pending ? 'Linking…' : 'Link guardian'}</button>

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

      <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save registration'}</button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}
