'use client';

import type { ReactNode } from 'react';
import { useActionState, useEffect, useRef, useState } from 'react';
import { staffAction, type ActionState } from './actions';
import { groupDutyRows } from '@/lib/people/staff-groups';

const EMPTY: ActionState = { ok: false, message: '' };

export type StaffRow = {
  id: number;
  staffNumber: string;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  photoUrl: string | null;
  /** What this person holds, grouped for display: class-teacher levels and
   * subject → levels (plugin staff.php $holdings), each with its assignment
   * ids so the Drop buttons end exactly those rows. */
  classTeacherLevels: Array<{ level: string; assignmentIds: number[] }>;
  subjects: Array<{ subject: string; levels: string[]; assignmentIds: number[] }>;
};

type LevelOption = { id: number; name: string; stage: string; armCount: number; classIds: number[]; arms: Array<{ id: number; name: string }> };
type SubjectOption = { id: number; name: string; code: string; stage: string };

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'teacher', label: 'Teacher' },
  { value: 'exam_officer', label: 'Examination Officer' },
  { value: 'vice_principal', label: 'Vice Principal' },
  { value: 'principal', label: 'Principal' },
];

const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

/**
 * Register a staff member — the plugin's field order and wording exactly
 * (staff.php): Title, First name, Surname, Sex, Email, Phone, Role, then the
 * passport photo last, with a live preview. The staff number, login and
 * temporary password are all generated and shown once, in person.
 */
export function RegisterStaffForm() {
  const [state, action, pending] = useActionState(staffAction, EMPTY);
  const [photo, setPhoto] = useState<string | null>(null);

  return (
    <form action={action} className="card sa-card" encType="multipart/form-data">
      <h2>Add a staff member</h2>
      <p className="muted" style={{ marginTop: -6 }}>Leave the staff ID blank to generate one, or type in an existing ID to keep a school's own numbering. The password is always generated. Give them a class or subject below once added.</p>

      <fieldset disabled={pending} className="sa-grid">
        <input type="hidden" name="operation" value="register" />

        <div><label htmlFor="s_title">Title</label><input id="s_title" name="title" type="text" placeholder="Mr / Mrs / Dr" maxLength={50} /></div>
        <div><label htmlFor="s_first">First name *</label><input id="s_first" name="firstName" type="text" required maxLength={100} /></div>
        <div><label htmlFor="s_last">Surname *</label><input id="s_last" name="lastName" type="text" required maxLength={100} /></div>
        <div>
          <label htmlFor="s_gender">Sex</label>
          <select id="s_gender" name="gender" defaultValue="">
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </div>
        <div><label htmlFor="s_email">Email</label><input id="s_email" name="email" type="email" maxLength={191} /></div>
        <div><label htmlFor="s_phone">Phone</label><input id="s_phone" name="phone" type="text" maxLength={50} /></div>
        <div>
          <label htmlFor="s_role">Role</label>
          <select id="s_role" name="role" defaultValue="teacher">
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="s_photo">Passport Photo</label>
          <input
            id="s_photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) { setPhoto(null); return; }
              const reader = new FileReader();
              reader.onload = (ev) => setPhoto(typeof ev.target?.result === 'string' ? ev.target.result : null);
              reader.readAsDataURL(file);
            }}
          />
          {photo && (
            <div style={{ marginTop: 8 }}>
              <img src={photo} alt="Passport preview" style={{ maxWidth: 80, maxHeight: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid #d8dcd4' }} />
            </div>
          )}
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>
        {pending ? 'Registering…' : 'Add staff member'}
      </button>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
      {state.ok && state.credentials && <p role="status" className="credentials">{state.credentials}</p>}
    </form>
  );
}

/** The plugin's chip multi-select (staff.php .chip-select): selected items
 * render as removable mint chips; the options live in a dropdown. The form
 * value is carried by hidden inputs rendered by the parent, not by this. */
function ChipSelect({ options, selectedIds, onToggle, placeholder }: {
  options: Array<{ id: number; label: string; hint?: ReactNode }>;
  selectedIds: number[];
  onToggle: (id: number) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  return (
    <div className="sa-chip" ref={ref}>
      <div className="sa-chip__input" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        {options.filter((o) => selectedIds.includes(o.id)).map((o) => (
          <span key={o.id} className="sa-chip__chip">
            {o.label}
            <button
              type="button" className="sa-chip__remove" aria-label={`Remove ${o.label}`}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(o.id); }}
            >×</button>
          </span>
        ))}
        {selectedIds.length === 0 && <span className="sa-chip__placeholder">{placeholder}</span>}
        <svg className="sa-chip__arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </div>
      {open && (
        <div className="sa-chip__dropdown">
          {options.map((o) => (
            <div
              key={o.id}
              className={`sa-chip__option${selectedIds.includes(o.id) ? ' is-selected' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggle(o.id); }}
            >
              {o.label}{o.hint ? <> {o.hint}</> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The plugin's assignment builder (staff.php): "What are you assigning?",
 * then rows of teacher + class levels + subjects, "+ Add another teacher",
 * save once. Choosing a teacher pre-fills what they already hold; choosing
 * levels narrows the subject list to what those levels offer.
 */
export function AssignDutiesForm({ staffOptions, levels, subjects, existing }: {
  staffOptions: Array<{ id: number; name: string }>;
  levels: LevelOption[];
  subjects: SubjectOption[];
  existing: Record<number, { classTeacherLevelIds: number[]; subjectTeacherLevelIds: number[]; subjectIds: number[]; classTeacherClassIds: number[]; subjectTeacherClassIds: number[]; subjectClasses: Record<number, number[]> }>;
}) {
  const [state, action, pending] = useActionState(staffAction, EMPTY);
  const [kind, setKind] = useState<'subject_teacher' | 'class_teacher'>('subject_teacher');
  const [rows, setRows] = useState<Array<{ key: number; staffId: number; classIds: number[]; subjectIds: number[]; prefill: string | null; spawnedBy?: number }>>([{ key: 0, staffId: 0, classIds: [], subjectIds: [], prefill: null }]);
  const nextKey = useRef(1);

  const update = (key: number, patch: Partial<typeof rows[number]>) => {
    setRows((rs) => rs.map((r) => r.key === key ? { ...r, ...patch } : r));
  };

  // Which levels pre-fill depends on the DUTY BEING BUILT, not everything
  // this teacher happens to hold — a class-teacher pick must only pre-select
  // levels where they are ALREADY the class teacher, never levels where they
  // merely teach a subject, and vice versa. See page.tsx's `existing` builder.
  //
  // Shared by chooseTeacher (a row's Teacher select) AND changeKind (the top
  // "What are you assigning?" select): switching kind after a teacher and
  // classes were already chosen must re-derive the pre-fill for the NEW kind,
  // not leave the previous kind's classes sitting there checked. That stale
  // carry-over — a subject-teacher's class still showing selected once you
  // switch to "Class teacher" — was the actual bug: the two duties were, in
  // effect, sharing one class list.
  const levelOfClass = (classId: number) => levels.find((l) => l.classIds.includes(classId));
  const armName = (classId: number) => levels.flatMap((l) => l.arms).find((a) => a.id === classId)?.name;

  // Pre-fill is the EXACT arms a teacher already holds. A teacher on Maths in
  // JSS 1A only is shown as JSS 1A only; they are never widened to JSS 1B/1C.
  const prefillFor = (staffId: number, forKind: 'subject_teacher' | 'class_teacher') => {
    const held = staffId ? existing[staffId] : undefined;
    type Group = { subjectIds: number[]; classIds: number[] };
    if (!held) return { groups: [] as Group[], classIds: [] as number[], subjectIds: [] as number[], prefill: null as string | null };
    if (forKind === 'class_teacher') {
      const classIds = held.classTeacherClassIds;
      const names = classIds.map(armName).filter(Boolean);
      return { groups: [] as Group[], classIds, subjectIds: [] as number[], prefill: names.length ? `Pre-filled: ${names.join(', ')}` : null };
    }
    // One entry per distinct set of classes: a subject keeps only the classes it is really taken in.
    const groups = groupDutyRows(held.subjectClasses);
    const total = groups.reduce((n, g) => n + g.subjectIds.length * g.classIds.length, 0);
    return {
      groups,
      classIds: groups[0]?.classIds ?? [], subjectIds: groups[0]?.subjectIds ?? [],
      prefill: total ? `Pre-filled: ${total} duty${total === 1 ? '' : 'ies'}${groups.length > 1 ? `, shown as ${groups.length} rows so each subject keeps only its own classes` : ''}` : null,
    };
  };

  /** Fill one row from a prefill, and add a further row (same teacher) for each extra group of classes. */
  const withPrefill = (rs: typeof rows, key: number, staffId: number, forKind: 'subject_teacher' | 'class_teacher') => {
    const { groups, classIds, subjectIds, prefill } = prefillFor(staffId, forKind);
    const spawned = groups.slice(1).map((g) => ({ key: nextKey.current++, staffId, classIds: g.classIds, subjectIds: g.subjectIds, prefill: null as string | null }));
    return rs.flatMap((r) => r.key === key ? [{ ...r, staffId, classIds, subjectIds, prefill }, ...spawned] : [r]);
  };

  const chooseTeacher = (key: number, staffId: number) => {
    // Rows an earlier choice of this teacher spawned are replaced, so choosing twice never piles up copies.
    setRows((rs) => {
      const cleaned = rs.filter((r) => !(r.spawnedBy === key));
      if (!staffId) return cleaned.map((r) => r.key === key ? { ...r, staffId, classIds: [], subjectIds: [], prefill: null } : r);
      const out = withPrefill(cleaned, key, staffId, kind);
      return out.map((r, i) => (i > 0 && !cleaned.some((c) => c.key === r.key) ? { ...r, spawnedBy: key } : r));
    });
  };

  const changeKind = (next: 'subject_teacher' | 'class_teacher') => {
    setKind(next);
    setRows((rs) => {
      let out = rs.filter((r) => r.spawnedBy === undefined);
      for (const r of out.slice()) {
        if (!r.staffId) { out = out.map((x) => x.key === r.key ? { ...x, classIds: [], subjectIds: [], prefill: null } : x); continue; }
        const before = out.length;
        out = withPrefill(out, r.key, r.staffId, next);
        out = out.map((x, i) => (i >= before && x.spawnedBy === undefined && !rs.some((o) => o.key === x.key) ? { ...x, spawnedBy: r.key } : x));
      }
      return out;
    });
  };

  // A subject no longer offered by the stages of the chosen classes is
  // deselected, exactly as the plugin's educbtNarrowSubjects does.
  const stagesOf = (classIds: number[]) => classIds.map((id) => levelOfClass(id)?.stage).filter(Boolean);
  const visibleSubjects = (classIds: number[]) => {
    if (!classIds.length) return subjects;
    const stages = stagesOf(classIds);
    return subjects.filter((s) => s.stage === 'both' || stages.includes(s.stage));
  };
  const setClasses = (key: number, classIds: number[]) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const stages = stagesOf(classIds);
    const subjectIds = classIds.length
      ? row.subjectIds.filter((sid) => {
        const subject = subjects.find((s) => s.id === sid);
        return subject && (subject.stage === 'both' || stages.includes(subject.stage));
      })
      : row.subjectIds;
    update(key, { classIds, subjectIds });
  };
  /** Tick or untick ONE arm. */
  const toggleArm = (key: number, classId: number) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    setClasses(key, row.classIds.includes(classId) ? row.classIds.filter((id) => id !== classId) : [...row.classIds, classId]);
  };
  /** Tick or untick a WHOLE level (every arm), the one-click shortcut. */
  const toggleWholeLevel = (key: number, level: LevelOption) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const all = level.classIds.every((id) => row.classIds.includes(id));
    setClasses(key, all
      ? row.classIds.filter((id) => !level.classIds.includes(id))
      : [...new Set([...row.classIds, ...level.classIds])]);
  };

  return (
    <form action={action} className="card sa-card">
      <h2>Assign teaching duties</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Pick a teacher, then every subject and every class they take. Tick a whole
        year group, or only the arms they teach (for example Mathematics in JSS 1A
        and 1B but not 1C). Several teachers can share the same subject and class:
        add a row for each. Add another row for the next teacher, then save once.
      </p>

      <fieldset disabled={pending}>
        <input type="hidden" name="operation" value="assign" />
        <input type="hidden" name="assignmentType" value={kind} />

        {/* Wrapped exactly like a row's Teacher field below (.sa-assign-row >
           .sa-field) so the two selects share the same label style and the
           same 100%/max-520px width, instead of this one sitting at native
           select width beside a full-width one. */}
        <div className="sa-assign-row">
          <div className="sa-field">
            <label htmlFor="bulk_type">What are you assigning?</label>
            <select
              id="bulk_type" value={kind}
              onChange={(e) => changeKind(e.target.value === 'class_teacher' ? 'class_teacher' : 'subject_teacher')}
            >
              <option value="subject_teacher">Subject teachers</option>
              <option value="class_teacher">Class teachers</option>
            </select>
          </div>
        </div>

        <div>
          {rows.map((row) => (
            <div key={row.key} className="sa-assign-row">
              <div className="sa-field">
                <label>Teacher</label>
                <select
                  name={`row${row.key}.staffId`}
                  value={row.staffId || ''}
                  onChange={(e) => chooseTeacher(row.key, Number(e.target.value))}
                >
                  <option value="">Choose a teacher</option>
                  {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {row.prefill && <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>{row.prefill}</p>}
              </div>

              <div className="sa-field">
                <label>Classes <span className="muted">(tick a whole year group, or just the arms you want)</span></label>
                <div className="sa-arm-picker">
                  {levels.map((l) => {
                    const picked = l.classIds.filter((id) => row.classIds.includes(id)).length;
                    const whole = l.classIds.length > 0 && picked === l.classIds.length;
                    return (
                      <div key={l.id} className="sa-arm-picker__level">
                        <label className="sa-arm-picker__whole">
                          <input
                            type="checkbox" checked={whole}
                            ref={(el) => { if (el) el.indeterminate = picked > 0 && !whole; }}
                            onChange={() => toggleWholeLevel(row.key, l)}
                          />
                          <strong>{l.name}</strong>
                          <span className="muted"> {l.arms.length > 1 ? `(all ${l.arms.length} arms)` : ''}</span>
                        </label>
                        {l.arms.length > 1 && (
                          <div className="sa-arm-picker__arms">
                            {l.arms.map((a) => (
                              <label key={a.id} className="sa-arm-picker__arm">
                                <input type="checkbox" checked={row.classIds.includes(a.id)} onChange={() => toggleArm(row.key, a.id)} />
                                {a.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {levels.length === 0 && <p className="muted">No classes have been created yet.</p>}
                </div>
                {/* Exactly the ticked arms are saved — nothing is widened to a
                    whole year group unless every arm is ticked. */}
                {row.classIds.map((cid) => <input key={`${row.key}-c-${cid}`} type="hidden" name={`row${row.key}.classIds`} value={cid} />)}
              </div>

              <div className="sa-field" hidden={kind === 'class_teacher'}>
                <label>
                  Subjects <span className="muted">
                    ({row.classIds.length ? `${visibleSubjects(row.classIds).length} offered by the chosen classes` : 'choose the classes first'})
                  </span>
                </label>
                <ChipSelect
                  options={visibleSubjects(row.classIds).map((s) => ({ id: s.id, label: s.name }))}
                  selectedIds={row.subjectIds}
                  onToggle={(id) => update(row.key, {
                    subjectIds: row.subjectIds.includes(id)
                      ? row.subjectIds.filter((sid) => sid !== id)
                      : [...row.subjectIds, id],
                  })}
                  placeholder="Click to select subjects…"
                />
                {row.subjectIds.map((sid) => (
                  <input key={`${row.key}-s-${sid}`} type="hidden" name={`row${row.key}.subjectIds`} value={sid} disabled={kind === 'class_teacher'} />
                ))}
              </div>

              {row.staffId > 0 && row.classIds.length > 0 && (kind === 'class_teacher' || row.subjectIds.length > 0) && (
                <p className="sa-assign-summary" role="note">
                  <strong>Saving will give</strong>{' '}
                  {staffOptions.find((t) => t.id === row.staffId)?.name ?? 'this teacher'}{' '}
                  {kind === 'class_teacher' ? 'as class teacher of ' : (
                    <>{row.subjectIds.map((sid) => subjects.find((x) => x.id === sid)?.name).filter(Boolean).join(', ')} in </>
                  )}
                  {row.classIds.map(armName).filter(Boolean).join(', ')}
                  {kind === 'subject_teacher' && row.subjectIds.length * row.classIds.length > 1
                    ? ` (${row.subjectIds.length * row.classIds.length} assignments, every subject in every class listed)` : ''}.
                  {' '}<span className="muted">Anything they already hold stays as it is.</span>
                </p>
              )}

              <button
                type="button" className="sa-btn sa-btn--ghost"
                onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                aria-label="Remove this row"
              >Remove</button>
            </div>
          ))}
        </div>

        <button
          type="button" className="sa-btn"
          onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, staffId: 0, classIds: [], subjectIds: [], prefill: null }])}
        >+ Add another teacher</button>
        <button type="submit" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginLeft: 8 }}>
          {pending ? 'Saving…' : 'Save assignments'}
        </button>
      </fieldset>

      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}

/**
 * One staff row — the plugin's table exactly: staff number, name (with photo),
 * role, what they hold, and an Edit toggle. The hidden row underneath carries
 * the edit form, the per-duty Drop buttons, password reset and stand-down —
 * the plugin puts every act-on-this-person control inside that row.
 */
export function StaffRowForm({ staff }: { staff: StaffRow }) {
  const [state, action, pending] = useActionState(staffAction, EMPTY);
  const [open, setOpen] = useState(false);
  const inactive = staff.status !== 'active';
  const fullName = `${staff.title ? `${staff.title} ` : ''}${staff.firstName} ${staff.lastName}`;
  const holdsSomething = staff.classTeacherLevels.length + staff.subjects.length > 0;

  return (
    <>
      <tr className={inactive ? 'row--inactive' : undefined}>
        <td><code>{staff.staffNumber}</code></td>
        <td>
          {staff.photoUrl
            ? <img src={staff.photoUrl} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', verticalAlign: 'middle', marginRight: 8, border: '1px solid #d8dcd4' }} />
            : null}
          {fullName}
          {inactive && <span className="muted" style={{ marginLeft: 6 }}>(stood down)</span>}
        </td>
        <td>{ROLE_LABEL[staff.role] ?? staff.role}</td>
        <td>
          {!holdsSomething
            ? <span className="muted">none yet</span>
            : (
              <>
                {staff.classTeacherLevels.map((l) => (
                  <div key={l.level} className="sa-sub" style={{ marginBottom: 2 }}>
                    <span className="sa-pill sa-pill--active">Class teacher</span> {l.level}
                  </div>
                ))}
                {staff.subjects.map((s) => (
                  <div key={s.subject} className="sa-sub" style={{ marginBottom: 2 }}>
                    <strong>{s.subject}</strong> <span className="muted">— {s.levels.join(', ')}</span>
                  </div>
                ))}
              </>
            )}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button type="button" className="sa-btn" onClick={() => setOpen(!open)}>Edit</button>
        </td>
      </tr>

      {open && (
        <tr className="sa-edit-row">
          <td colSpan={5} style={{ background: '#f5f7f6' }}>
            <form action={action} encType="multipart/form-data" className="sa-edit-form" style={{ padding: '12px 0' }}>
              <input type="hidden" name="operation" value="update" />
              <input type="hidden" name="staffId" value={staff.id} />
              <div className="sa-grid">
                <div><label htmlFor={`title-${staff.id}`}>Title</label><input id={`title-${staff.id}`} name="title" type="text" defaultValue={staff.title ?? ''} maxLength={50} /></div>
                <div><label htmlFor={`fn-${staff.id}`}>First name *</label><input id={`fn-${staff.id}`} name="firstName" type="text" required defaultValue={staff.firstName} maxLength={100} /></div>
                <div><label htmlFor={`ln-${staff.id}`}>Surname *</label><input id={`ln-${staff.id}`} name="lastName" type="text" required defaultValue={staff.lastName} maxLength={100} /></div>
                <div><label htmlFor={`sn-${staff.id}`}>Staff ID</label><input id={`sn-${staff.id}`} name="staffNumber" type="text" defaultValue={staff.staffNumber} maxLength={50} /></div>
                <div><label htmlFor={`em-${staff.id}`}>Email</label><input id={`em-${staff.id}`} name="email" type="email" defaultValue={staff.email ?? ''} maxLength={191} /></div>
                <div><label htmlFor={`ph-${staff.id}`}>Phone</label><input id={`ph-${staff.id}`} name="phone" type="tel" defaultValue={staff.phone ?? ''} maxLength={50} /></div>
                <div>
                  <label htmlFor={`role-${staff.id}`}>Role</label>
                  <select id={`role-${staff.id}`} name="role" defaultValue={staff.role}>
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`photo-${staff.id}`}>Passport Photo</label>
                  <input id={`photo-${staff.id}`} type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
                  {staff.photoUrl && (
                    <div style={{ marginTop: 6 }}>
                      <img src={staff.photoUrl} alt="" style={{ width: 60, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid #d8dcd4' }} />
                      <span className="muted" style={{ fontSize: '.8rem', marginLeft: 4 }}>Current photo</span>
                    </div>
                  )}
                </div>
              </div>
              {staff.role !== 'principal' ? (
                <label className="sa-check" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontWeight: 400, fontSize: 13 }}>
                  <input type="checkbox" name="confirmTransfer" />
                  Transfer the principal role to this person if it is taken
                </label>
              ) : null}
              <button type="submit" name="operation" value="update" disabled={pending} className="sa-btn sa-btn--primary" style={{ marginTop: 12 }}>
                {pending ? 'Saving…' : 'Save changes'}
              </button>
            </form>

            {holdsSomething && (
              <div style={{ borderTop: '1px solid #e2e8e4', paddingTop: 12, marginTop: 4 }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '.9rem' }}>Drop an assignment</h4>
                {staff.classTeacherLevels.map((l) => (
                  <form
                    key={`ct-${l.level}`} action={action} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}
                    onSubmit={(e) => { if (!window.confirm(`Drop class teacher ${l.level} from this teacher?`)) e.preventDefault(); }}
                  >
                    <input type="hidden" name="operation" value="drop" />
                    {l.assignmentIds.map((id) => <input key={id} type="hidden" name="assignmentIds" value={id} />)}
                    <span style={{ fontSize: '.85rem', flex: 1 }}>
                      <span className="sa-pill sa-pill--active">Class teacher</span> <span className="muted">{l.level}</span>
                    </span>
                    <button type="submit" className="sa-btn sa-btn--small sa-btn--danger">Drop</button>
                  </form>
                ))}
                {staff.subjects.map((s) => (
                  <form
                    key={`sub-${s.subject}`} action={action} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}
                    onSubmit={(e) => { if (!window.confirm(`Drop ${s.subject} from this teacher?`)) e.preventDefault(); }}
                  >
                    <input type="hidden" name="operation" value="drop" />
                    {s.assignmentIds.map((id) => <input key={id} type="hidden" name="assignmentIds" value={id} />)}
                    <span style={{ fontSize: '.85rem', flex: 1 }}>{s.subject} <span className="muted">- {s.levels.join(', ')}</span></span>
                    <button type="submit" className="sa-btn sa-btn--small sa-btn--danger">Drop</button>
                  </form>
                ))}
              </div>
            )}

            <form action={action} style={{ borderTop: '1px solid #e2e8e4', paddingTop: 12, marginTop: 4 }}>
              <input type="hidden" name="operation" value="reset" />
              <input type="hidden" name="staffId" value={staff.id} />
              <button
                type="submit" disabled={pending} className="sa-btn"
                onClick={(e) => { if (!window.confirm('Reset this password? The current one stops working immediately.')) e.preventDefault(); }}
              >Reset their password</button>
              <span className="muted" style={{ marginLeft: 8 }}>Shown once; they must change it at next sign-in.</span>
            </form>

            {inactive ? (
              <form action={action} style={{ borderTop: '1px solid #e2e8e4', paddingTop: 12, marginTop: 4 }}>
                <input type="hidden" name="operation" value="reactivate" />
                <input type="hidden" name="staffId" value={staff.id} />
                <button type="submit" disabled={pending} className="sa-btn">Reactivate</button>
                <span className="muted" style={{ marginLeft: 8 }}>Their login works again.</span>
              </form>
            ) : (
              <form
                action={action} style={{ borderTop: '1px solid #e2e8e4', padding: '12px 0' }}
                onSubmit={(e) => { if (!window.confirm('Stand this staff member down? Their record and history are kept.')) e.preventDefault(); }}
              >
                <input type="hidden" name="operation" value="stand-down" />
                <input type="hidden" name="staffId" value={staff.id} />
                {holdsSomething && (
                  <p className="sa-note--warn" style={{ marginBottom: 8 }}>
                    This person still holds:{' '}
                    {[
                      ...staff.classTeacherLevels.map((l) => `Class teacher: ${l.level}`),
                      ...staff.subjects.map((s) => `${s.subject} (${s.levels.join(', ')})`),
                    ].join('; ')}.
                    Reassign these under &ldquo;Assign teaching duties&rdquo; above first —
                    a class left with no teacher has nobody responsible for its remarks or promotion.
                  </p>
                )}
                {holdsSomething && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, fontSize: 13.5 }}>
                    <input type="checkbox" name="confirmReassign" style={{ width: 'auto' }} />
                    Stand them down anyway and end these assignments
                  </label>
                )}
                <button type="submit" disabled={pending} className="sa-btn sa-btn--danger" style={{ marginTop: 10 }}>Remove staff member</button>
              </form>
            )}
          </td>
        </tr>
      )}

      {state.message || (state.ok && state.credentials)
        ? (
          <tr className="row--message">
            <td colSpan={5}>
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
