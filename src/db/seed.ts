/**
 * Seed a working school.
 *
 * Creates enough for a real sign-in and a walk through the portal: a school, an
 * academic calendar, class structure, the standard NERDC subject offering, a
 * principal, a teacher, and a handful of students.
 *
 * Uses the UNPOOLED connection and runs as the OWNER, deliberately bypassing
 * RLS — there is no tenant yet, because this is what creates the tenant.
 *
 *   npm run db:seed
 *
 * Safe to re-run: it refuses if the school code already exists rather than
 * producing a second copy of everything.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import { hashPassword, generateInitialPassword } from '../lib/auth/password';

const schema = { ...core, ...people };

const SCHOOL_CODE = 'DEMO001';

/**
 * The standard Nigerian secondary offering.
 *
 * Codes carry the level distinction — junior Mathematics is MTH-J, senior
 * General Mathematics is MTH. Without that a teacher choosing a subject sees two
 * identical rows and cannot tell which paper they are writing.
 */
const SUBJECTS: Array<{
  name: string; code: string; stage: 'junior' | 'senior' | 'both';
  core?: boolean; stream?: 'science' | 'arts' | 'business';
}> = [
  // Junior — all core
  { name: 'English Studies', code: 'ENG-J', stage: 'junior', core: true },
  { name: 'Mathematics', code: 'MTH-J', stage: 'junior', core: true },
  { name: 'Basic Science', code: 'BSC', stage: 'junior', core: true },
  { name: 'Basic Technology', code: 'BTC', stage: 'junior', core: true },
  { name: 'Social Studies', code: 'SOS', stage: 'junior', core: true },
  { name: 'Civic Education', code: 'CVE-J', stage: 'junior', core: true },
  { name: 'Business Studies', code: 'BUS-J', stage: 'junior', core: true },
  { name: 'Agricultural Science', code: 'AGR-J', stage: 'junior', core: true },
  { name: 'Physical and Health Education', code: 'PHE-J', stage: 'junior', core: true },
  { name: 'Cultural and Creative Arts', code: 'CCA', stage: 'junior', core: true },
  { name: 'Computer Studies', code: 'CMP-J', stage: 'junior', core: true },
  { name: 'Christian Religious Studies', code: 'CRS-J', stage: 'junior' },
  { name: 'Islamic Studies', code: 'IRS-J', stage: 'junior' },
  { name: 'Nigerian Language', code: 'NLG-J', stage: 'junior' },
  { name: 'French', code: 'FRN-J', stage: 'junior' },

  // Senior — compulsory across every stream
  { name: 'English Language', code: 'ENG', stage: 'senior', core: true },
  { name: 'General Mathematics', code: 'MTH', stage: 'senior', core: true },
  { name: 'Civic Education', code: 'CVE', stage: 'senior', core: true },

  // Senior — Science
  { name: 'Physics', code: 'PHY', stage: 'senior', stream: 'science' },
  { name: 'Chemistry', code: 'CHM', stage: 'senior', stream: 'science' },
  { name: 'Biology', code: 'BIO', stage: 'senior', stream: 'science' },
  { name: 'Further Mathematics', code: 'FMT', stage: 'senior', stream: 'science' },
  { name: 'Agricultural Science', code: 'AGR', stage: 'senior', stream: 'science' },

  // Senior — Arts
  { name: 'Literature in English', code: 'LIT', stage: 'senior', stream: 'arts' },
  { name: 'Government', code: 'GOV', stage: 'senior', stream: 'arts' },
  { name: 'History', code: 'HIS', stage: 'senior', stream: 'arts' },
  { name: 'Christian Religious Studies', code: 'CRS', stage: 'senior', stream: 'arts' },
  { name: 'Geography', code: 'GEO', stage: 'senior', stream: 'arts' },

  // Senior — Business
  { name: 'Financial Accounting', code: 'ACC', stage: 'senior', stream: 'business' },
  { name: 'Commerce', code: 'COM', stage: 'senior', stream: 'business' },
  { name: 'Economics', code: 'ECO', stage: 'senior', stream: 'business' },

  // Senior — any stream
  { name: 'Computer Science', code: 'CMP', stage: 'senior' },
  { name: 'Data Processing', code: 'DPR', stage: 'senior' },
];

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (!url) throw new Error('DATABASE_URL_UNPOOLED is required for seeding.');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const existing = await db
      .select({ id: core.schools.id })
      .from(core.schools)
      .where(eq(core.schools.code, SCHOOL_CODE))
      .limit(1);

    if (existing.length > 0) {
      console.log(`School ${SCHOOL_CODE} already exists (id ${existing[0]!.id}). Nothing to do.`);
      return;
    }

    console.log('Seeding…');

    // ── School ───────────────────────────────────────────────────────────────
    const [school] = await db.insert(core.schools).values({
      name: 'Demo International School',
      code: SCHOOL_CODE,
      subdomain: 'demo',
      email: 'office@demo.school',
      principalName: 'Dr. S. Okonkwo',
    }).returning();

    const schoolId = school!.id;

    // ── Calendar ─────────────────────────────────────────────────────────────
    const [session] = await db.insert(core.academicSessions).values({
      schoolId, title: '2026/2027', isCurrent: true,
    }).returning();

    const [term] = await db.insert(core.terms).values([
      { schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true },
      { schoolId, sessionId: session!.id, title: 'Second Term', position: 2 },
      { schoolId, sessionId: session!.id, title: 'Third Term', position: 3 },
    ]).returning();

    // ── Departments and levels ───────────────────────────────────────────────
    const departments = await db.insert(core.departments).values([
      { schoolId, name: 'Science', sortOrder: 1 },
      { schoolId, name: 'Arts', sortOrder: 2 },
      { schoolId, name: 'Commercial', sortOrder: 3 },
    ]).returning();

    const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]));

    const levels = await db.insert(core.classLevels).values([
      { schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 },
      { schoolId, name: 'JSS 2', stage: 'junior', levelOrder: 2 },
      { schoolId, name: 'JSS 3', stage: 'junior', levelOrder: 3 },
      { schoolId, name: 'SS 1', stage: 'senior', levelOrder: 4 },
      { schoolId, name: 'SS 2', stage: 'senior', levelOrder: 5 },
      { schoolId, name: 'SS 3', stage: 'senior', levelOrder: 6 },
    ]).returning();

    // ── Classes ──────────────────────────────────────────────────────────────
    // Junior levels have arms but no department; senior levels split by stream.
    const classRows: Array<typeof core.classes.$inferInsert> = [];

    for (const level of levels) {
      if (level.stage === 'junior') {
        for (const arm of ['A', 'B']) {
          classRows.push({
            schoolId, levelId: level.id, departmentId: null, arm,
            displayName: `${level.name} ${arm}`,
          });
        }
      } else {
        for (const [name, id] of deptByName) {
          classRows.push({
            schoolId, levelId: level.id, departmentId: id, arm: 'A',
            displayName: `${level.name} ${name.charAt(0).toUpperCase()}${name.slice(1)}`,
          });
        }
      }
    }

    const classes = await db.insert(core.classes).values(classRows).returning();

    // ── Subjects ─────────────────────────────────────────────────────────────
    await db.insert(core.subjects).values(
      SUBJECTS.map((s) => ({
        schoolId,
        name: s.name,
        code: s.code,
        stage: s.stage,
        category: (s.core ? 'core' : 'elective') as 'core' | 'elective',
        departmentId: s.stream ? deptByName.get(s.stream) ?? null : null,
        isCompulsory: Boolean(s.core),
      })),
    );

    // ── People ───────────────────────────────────────────────────────────────
    // Passwords are generated, printed once, and must be changed at first sign
    // in. Nothing memorable and nothing reused.
    const principalPassword = generateInitialPassword();
    const teacherPassword = generateInitialPassword();
    const studentPassword = generateInitialPassword();

    const [principalUser] = await db.insert(people.users).values({
      schoolId, role: 'principal', loginId: 'PRINCIPAL',
      passwordHash: await hashPassword(principalPassword),
      mustChangePassword: true,
    }).returning();

    await db.insert(people.staff).values({
      schoolId, userId: principalUser!.id, staffNumber: 'PRINCIPAL',
      firstName: 'Samuel', lastName: 'Okonkwo', role: 'principal',
      email: 'principal@demo.school',
    });

    const [teacherUser] = await db.insert(people.users).values({
      schoolId, role: 'teacher', loginId: 'STF001',
      passwordHash: await hashPassword(teacherPassword),
      mustChangePassword: true,
    }).returning();

    const [teacher] = await db.insert(people.staff).values({
      schoolId, userId: teacherUser!.id, staffNumber: 'STF001',
      firstName: 'Folake', lastName: 'Adeyemi', role: 'teacher',
      email: 'f.adeyemi@demo.school',
    }).returning();

    // One class teacher duty, so scoped authorisation has something to test.
    const jss1a = classes.find((c) => c.displayName === 'JSS 1 A');

    if (jss1a) {
      await db.insert(people.staffAssignments).values({
        schoolId, staffId: teacher!.id, classId: jss1a.id,
        subjectId: null, assignmentType: 'class_teacher',
      });
    }

    // Students, all in JSS 1 A.
    const sharedStudentHash = await hashPassword(studentPassword);

    const studentSeed = [
      ['2026010001', 'Inioluwa', 'Olayiwola', 'female'],
      ['2026010002', 'Chidinma', 'Adebayo', 'female'],
      ['2026010003', 'Tunde', 'Bakare', 'male'],
      ['2026010004', 'Amaka', 'Nwosu', 'female'],
      ['2026010005', 'Yusuf', 'Ibrahim', 'male'],
    ] as const;

    for (const [admission, first, last, gender] of studentSeed) {
      const [su] = await db.insert(people.users).values({
        schoolId, role: 'student', loginId: admission,
        passwordHash: sharedStudentHash, mustChangePassword: true,
      }).returning();

      const [student] = await db.insert(people.students).values({
        schoolId, userId: su!.id, admissionNumber: admission,
        firstName: first, lastName: last, gender,
        admittedAt: new Date(),
      }).returning();

      if (jss1a) {
        await db.insert(people.enrollments).values({
          schoolId, studentId: student!.id, classId: jss1a.id,
          sessionId: session!.id, status: 'active',
        });
      }
    }

    console.log(`
Seeded school ${schoolId} — Demo International School

  Sign in at   http://demo.localhost:3000/sign-in
  (add "127.0.0.1 demo.localhost" to /etc/hosts, or use the deployed subdomain)

  Principal    PRINCIPAL     ${principalPassword}
  Teacher      STF001        ${teacherPassword}
  Students     2026010001…5  ${studentPassword}

All accounts must change password at first sign in.
These are printed once and are not recoverable — note them now.
`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
