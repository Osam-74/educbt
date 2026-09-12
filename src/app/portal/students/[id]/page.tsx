import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { getStudent, listClasses, isSchoolWide } from '@/lib/queries';
import { forSchool, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import {
  EditStudentForm, StandingForm, GuardianForm, SubjectRegistrationForm,
} from '../StudentForms';
import { subjectRegistrationView } from '@/lib/people/students';

export const dynamic = 'force-dynamic';

export default async function StudentProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requireSchoolSession();
  const studentId = Number(id);

  const record = await getStudent(actor, studentId);

  // Not found and not permitted return the same thing on purpose. Telling a
  // teacher "that student exists but is not yours" confirms the record exists.
  if (!record) notFound();

  const { student, enrolment, subjects } = record;
  const office = isSchoolWide(actor.role);

  // Guardians linked to this student — the parents who see the results and
  // the messages. Read through the same tenant-scoped transaction as the rest.
  const guardians = await forSchool(actor.schoolId, async (tx) =>
    tx.select({
      id: schema.guardians.id,
      fullName: schema.guardians.fullName,
      email: schema.guardians.email,
      phone: schema.guardians.phone,
      relationship: schema.guardianStudent.relationship,
      canViewResults: schema.guardianStudent.canViewResults,
      inviteStatus: schema.guardians.inviteStatus,
    }).from(schema.guardianStudent)
      .innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
      .where(and(
        eq(schema.guardianStudent.studentId, studentId),
        eq(schema.guardianStudent.schoolId, actor.schoolId),
      )),
  );

  // The registration view (compulsory / electives / what is pinned by marks) is
  // computed by the same service that saves it, so the two can never disagree.
  let registration = null;
  try {
    registration = await subjectRegistrationView(actor, studentId);
  } catch {
    registration = null; // no current session yet — the form simply hides
  }

  const classes = await listClasses(actor);

  const facts: Array<[string, string]> = [
    ['Sex', student.gender ? student.gender[0]!.toUpperCase() + student.gender.slice(1) : '—'],
    ['Date of birth', student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : '—'],
    ['Student ID', student.admissionNumber],
    ['Admitted', student.admittedAt ? student.admittedAt.toISOString().slice(0, 10) : '—'],
  ];

  return (
    <>
      <p><Link href="/portal/students">&larr; All students</Link></p>

      <section className="id-card">
        <div className="id-card__photo">
          {student.photoUrl
            ? <img src={student.photoUrl} alt="" />
            : <span>No photograph</span>}
        </div>
        <div className="id-card__body">
          <h1>{student.firstName} {student.lastName}</h1>
          <p className="id-card__meta">
            {student.admissionNumber}
            {enrolment?.className ? ` · ${enrolment.className}` : ' · Unenrolled'}
            {' · '}
            <span className={`pill pill--${student.status}`}>{student.status}</span>
          </p>
          <dl className="facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}:</dt><dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <h2>Edit record</h2>
          <EditStudentForm
            student={{
              id: studentId,
              firstName: student.firstName,
              lastName: student.lastName,
              gender: student.gender,
              dateOfBirth: student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : null,
              admissionNumber: student.admissionNumber,
              classId: enrolment?.classId ?? null,
            }}
            classes={classes}
          />
        </section>

        {office && (
          <section className="card">
            <h2>Standing</h2>
            <StandingForm studentId={studentId} status={student.status} />
          </section>
        )}

        <section className="card">
          <h2>Guardians ({guardians.length})</h2>
          {guardians.length > 0 && (
            <table className="tbl">
              <thead>
                <tr><th>Name</th><th>Contact</th><th>Relationship</th><th>Results</th><th>Invite</th></tr>
              </thead>
              <tbody>
                {guardians.map((g) => (
                  <tr key={g.id}>
                    <td>{g.fullName}</td>
                    <td>{g.email ?? g.phone ?? '—'}</td>
                    <td>{g.relationship ?? 'parent'}</td>
                    <td>{g.canViewResults ? 'May view' : 'No'}</td>
                    <td><span className={`pill pill--${g.inviteStatus ?? 'pending'}`}>{g.inviteStatus ?? 'pending'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {office && <GuardianForm studentId={studentId} />}
          {!office && guardians.length === 0 && <p className="muted">The school office links guardians.</p>}
        </section>

        <section className="card">
          <h2>Subject registration</h2>
          {registration
            ? (
              <SubjectRegistrationForm
                studentId={studentId}
                core={registration.core}
                electives={registration.electives}
                registeredIds={registration.registered.map((r) => r.id)}
                protectedIds={registration.registered.filter((r) => r.protectedByActivity).map((r) => r.id)}
              />
            )
            : (
              <p className="muted">
                Subject registration needs a current academic session. Set one
                before registering subjects for {student.firstName}.
              </p>
            )}
          <p className="muted">
            Currently registered: {subjects.length === 0 ? 'none yet' : subjects.map((s) => s.name).join(', ')}.
          </p>
        </section>
      </div>
    </>
  );
}
