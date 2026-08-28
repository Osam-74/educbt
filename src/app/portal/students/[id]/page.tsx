import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { getStudent } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function StudentProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requireSchoolSession();

  const record = await getStudent(actor, Number(id));

  // Not found and not permitted return the same thing on purpose. Telling a
  // teacher "that student exists but is not yours" confirms the record exists.
  if (!record) notFound();

  const { student, enrolment, subjects } = record;

  const facts: Array<[string, string]> = [
    ['Gender', student.gender ? student.gender[0]!.toUpperCase() + student.gender.slice(1) : '—'],
    ['Date of birth', student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : '—'],
    ['Parent', student.parentName ?? '—'],
    ['Parent phone', student.parentPhone ?? '—'],
    ['Parent email', student.parentEmail ?? '—'],
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
            {enrolment?.className ? ` · ${enrolment.className}` : ''}
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

      <section className="card">
        <h2>Registered subjects ({subjects.length})</h2>
        {subjects.length === 0 ? (
          <p className="muted">
            None registered. Registration decides what this student sits — an
            unregistered subject never appears on their timetable.
          </p>
        ) : (
          <ul className="bullets">
            {subjects.map((s) => (
              <li key={s.id}>{s.name} <span className="muted">({s.code})</span></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
