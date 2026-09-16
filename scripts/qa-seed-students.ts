/**
 * One-off QA fixture for the Students register visual QA pass. NOT a test —
 * leaves data in the local *_ca_test database and prints a ready-to-use
 * session cookie for Playwright/curl.
 *
 *   set -a && . .env.local && set +a && npx tsx scripts/qa-seed-students.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
    throw new Error('QA seed requires a disposable local *_ca_test database.');
  }
  const { schema } = await import('../src/db');
  const { createSession } = await import('../src/lib/auth/session-store');
  const { savePassportPhoto } = await import('../src/lib/people/photos');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });

  const code = 'QA' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'QA Students School', code, settings: { assessmentComponents: [] } }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true }).returning();
  const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First term', position: 1, isCurrent: true }).returning();
  const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
  const classes = await db.insert(schema.classes).values([
    { schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' },
    { schoolId, levelId: level!.id, displayName: 'SS1 B', arm: 'B' },
  ]).returning();

  // The office.
  const [principalUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'prin-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
  await db.insert(schema.staff).values({ schoolId, userId: principalUser!.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal' });
  const principal = { schoolId, userId: principalUser!.id, staffId: null, role: 'principal' as const, loginId: principalUser!.loginId, studentId: null };

  // A class teacher holding SS1 A only — their additions go pending.
  const [teacherUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
  const [teacherStaff] = await db.insert(schema.staff).values({ schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'T0', firstName: 'Tunde', lastName: 'Teacher' }).returning();
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacherStaff!.id, classId: classes[0]!.id, assignmentType: 'class_teacher', status: 'active' });

  // Passport photos: two students carry one, the rest do not — the row must
  // read fine either way.
  const photo = await savePassportPhoto(principal, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', { type: 'image/png' }));

  type Row = {
    admission: string; firstName: string; lastName: string; gender: string;
    classIdx: number;
    status: 'active' | 'suspended' | 'withdrawn' | 'pending_approval';
    photo?: string; parent?: boolean;
  };
  const roster: Row[] = [
    { admission: 'QAS/0001', firstName: 'Ada', lastName: 'Obi', gender: 'female', classIdx: 0, status: 'active', photo: photo ?? undefined, parent: true },
    { admission: 'QAS/0002', firstName: 'Chidi', lastName: 'Okoro', gender: 'male', classIdx: 0, status: 'active', photo: photo ?? undefined },
    { admission: 'QAS/0003', firstName: 'Fatima', lastName: 'Yusuf', gender: 'female', classIdx: 0, status: 'active', parent: true },
    { admission: 'QAS/0004', firstName: 'Bola', lastName: 'Adeyemi', gender: 'male', classIdx: 1, status: 'active' },
    { admission: 'QAS/0005', firstName: 'Emeka', lastName: 'Nwosu', gender: 'male', classIdx: 1, status: 'active' },
    { admission: 'QAS/0006', firstName: 'Grace', lastName: 'Ojo', gender: 'female', classIdx: 1, status: 'suspended' },
    { admission: 'QAS/0007', firstName: 'Ibrahim', lastName: 'Sani', gender: 'male', classIdx: 0, status: 'withdrawn' },
    { admission: 'QAS/0008', firstName: 'Halima', lastName: 'Bello', gender: 'female', classIdx: 1, status: 'pending_approval' },
  ];

  for (const r of roster) {
    const [su] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: r.admission, passwordHash: 'unused', mustChangePassword: true }).returning();
    const [st] = await db.insert(schema.students).values({
      schoolId, userId: su!.id, admissionNumber: r.admission,
      firstName: r.firstName, lastName: r.lastName, gender: r.gender,
      photoUrl: r.photo ?? null,
      parentName: r.parent ? `Mrs ${r.firstName} Senior` : null,
      parentPhone: r.parent ? '+2348031234567' : null,
      status: r.status,
    }).returning();
    await db.insert(schema.enrollments).values({
      schoolId, studentId: st!.id, classId: classes[r.classIdx]!.id,
      sessionId: session!.id,
      status: r.status === 'pending_approval' ? 'pending_approval' : 'active',
    });
  }

  const cookie = await createSession(principalUser!.id, null, null);
  console.log(JSON.stringify({
    schoolId,
    principalCookie: `educbt.session=${cookie.token}`,
    classAId: classes[0]!.id,
    code,
  }, null, 2));
  await owner.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
