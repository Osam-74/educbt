/**
 * Communications integration checks: notifications, announcements, messages,
 * and the email event queue.
 * Run with the app-role and owner URLs pointing at a disposable LOCAL
 * database; never at production.
 *   npx tsx src/db/test-comms.ts
 *
 * Legacy reference: includes/Services/{NotificationService,AnnouncementService,
 * EmailQueueService}.php and the messaging endpoints.
 *
 * Covers: typed in-app delivery, read/unread lifecycle, preference gating of
 * the email fan-out, audience capability rules (a class teacher addresses
 * their own class and nothing wider), audience resolution to concrete users,
 * announcement visibility per role, message scope (no student recipients, a
 * teacher may only reach guardians of their own classes, participant-only
 * threads), provider-independent queue drain semantics (claim, send, record
 * failure), and cross-tenant isolation at both the service and RLS layers.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

const schoolIds: number[] = [];

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    if (!process.env[key]) throw new Error(`Comms tests require ${key} in the environment.`);
  }
  const { schema, forSchool } = await import('@/db');
  const notifications = await import('@/lib/comms/notifications');
  const announcements = await import('@/lib/comms/announcements');
  const messages = await import('@/lib/comms/messages');
  const email = await import('@/lib/comms/email');
  const events = await import('@/lib/comms/events');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (name: string, fn: () => unknown | Promise<unknown>, fragment?: string) => {
    try {
      await fn();
    } catch (error) {
      if (fragment && !(error instanceof Error && error.message.includes(fragment))) {
        throw new Error(`${name}: expected "${fragment}", got "${error instanceof Error ? error.message : error}"`);
      }
      count++; console.log('PASS  ' + name);
      return;
    }
    throw new Error(`${name}: expected a rejection, got success`);
  };
  const actor = (userId: number, schoolId: number, role: string, staffId: number | null = null, studentId: number | null = null): Actor =>
    ({ userId, schoolId, role, loginId: 'test', staffId, studentId });

  async function fixture() {
    const code = 'CM' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Comms Test School', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [level2] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS2', levelOrder: 2 }).returning();
    const [dept] = await db.insert(schema.departments).values({ schoolId, name: 'Science' }).returning();
    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: level!.id, displayName: 'JSS1 Gold', arm: 'Gold' },
      { schoolId, levelId: level!.id, displayName: 'JSS1 Green', arm: 'Green' },
      { schoolId, levelId: level2!.id, displayName: 'JSS2 Gold', arm: 'Gold', departmentId: dept!.id },
    ]).returning();
    const [c1, c2, c3] = classes as unknown as [{ id: number }, { id: number }, { id: number }];

    const user = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'student' | 'parent', tag = '') => {
      const loginId = role === 'parent' || role === 'teacher' || role === 'principal' || role === 'exam_officer'
        ? `${role}.${tag}.${code.toLowerCase()}@example.com` : `${role}${tag}-${code}`;
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning();
      return u!;
    };

    const principal = await user('principal');
    const vice = await user('vice_principal');
    const teacher = await user('teacher', 'A');
    const teacherB = await user('teacher', 'B');

    // Staff records: teacher A teaches JSS1 Gold; teacher B teaches JSS1 Green.
    const staffUser = async (u: { id: number }, tag: string) => {
      const [st] = await db.insert(schema.staff).values({ schoolId, userId: u.id, staffNumber: `${code}/${tag}`, firstName: 'Tee', lastName: tag, email: `${tag.toLowerCase()}.${code.toLowerCase()}@example.com`, role: 'teacher', status: 'active' }).returning();
      return st!;
    };
    const staffA = await staffUser(teacher, 'Alpha');
    const staffB = await staffUser(teacherB, 'Beta');
    const assignment = async (staffId: number, classId: number) =>
      db.insert(schema.staffAssignments).values({ schoolId, staffId, classId, assignmentType: 'subject_teacher', status: 'active' });
    await assignment(staffA.id, c1!.id);
    await assignment(staffB.id, c2!.id);

    // Students with portal accounts, enrolled in classes.
    const mkStudent = async (tag: string, classId: number) => {
      const u = await user('student', tag);
      const [s] = await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: `${code}/${tag}`, firstName: tag, lastName: 'Student', status: 'active' }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId, sessionId: session!.id, status: 'active' });
      return { user: u, student: s! };
    };
    const stGold1 = await mkStudent('GOLD1', c1!.id);
    const stGreen1 = await mkStudent('GRN1', c2!.id);

    // Guardians: one linked to the JSS1 Gold student (may view results), one
    // to the JSS1 Green student, plus one Gold guardian who may NOT view results.
    const mkGuardian = async (tag: string, childClass: { id: number }, childStudent: { id: number }, canViewResults = true) => {
      const u = await user('parent', tag);
      const [g] = await db.insert(schema.guardians).values({ schoolId, userId: u.id, fullName: `Guardian ${tag}`, email: u.loginId, inviteStatus: 'accepted' }).returning();
      await db.insert(schema.guardianStudent).values({ schoolId, guardianId: g!.id, studentId: childStudent.id, canViewResults });
      return { user: u, guardian: g! };
    };
    const gGold = await mkGuardian('GOLD', c1!, stGold1.student);
    const gGreen = await mkGuardian('GREEN', c2!, stGreen1.student);

    return {
      code, schoolId, sessionId: session!.id, c1: c1!, c2: c2!, c3: c3!,
      levelId: level!.id, deptId: dept!.id,
      principal, vice, teacher, teacherB, staffA, staffB,
      stGold1, stGreen1, gGold, gGreen,
    };
  }

  const F = await fixture();
  const A = actor(F.principal.id, F.schoolId, 'principal');
  const T = actor(F.teacher.id, F.schoolId, 'teacher', F.staffA.id);
  const TB = actor(F.teacherB.id, F.schoolId, 'teacher', F.staffB.id);
  const V = actor(F.vice.id, F.schoolId, 'vice_principal');

  // A second school for cross-tenant checks.
  const [schoolB] = await db.insert(schema.schools).values({ name: 'Comms Other School', code: 'CB' + randomUUID().slice(0, 6).toUpperCase(), settings: { assessmentComponents: [] } }).returning();
  schoolIds.push(schoolB!.id);
  const [ub] = await db.insert(schema.users).values({ schoolId: schoolB!.id, role: 'principal', loginId: 'b-' + F.code, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning();
  const B = actor(ub!.id, schoolB!.id, 'principal');

  const nid = async (userId: number, schoolId = F.schoolId) =>
    (await db.select({ n: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.schoolId, schoolId))))[0]?.n;

  console.log('── notifications ──');
  await check('notify inserts a typed row with the default link for its type', async () => {
    const n = await forSchool(F.schoolId, (tx) => notifications.notify(tx, F.schoolId, {
      userId: F.stGold1.user.id, type: 'result_published', title: 'Your result is available',
    }));
    assert.equal(n, 1);
    assert.ok(await nid(F.stGold1.user.id));
  });

  await check('inbox returns newest first and unread counts only unread', async () => {
    const before = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    await forSchool(F.schoolId, (tx) => notifications.notify(tx, F.schoolId, {
      userId: F.stGold1.user.id, type: 'announcement', title: 'Second notice',
    }));
    const rows = await forSchool(F.schoolId, (tx) => notifications.inbox(tx, { schoolId: F.schoolId, userId: F.stGold1.user.id }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.title, 'Second notice', 'newest first');
    assert.equal(rows[0]!.isRead, false);
    const after = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    assert.equal(after, before + 1);
  });

  await check('invalid notifications are filtered, not inserted', async () => {
    const n = await forSchool(F.schoolId, (tx) => notifications.notifyMany(tx, F.schoolId, [
      { userId: 0, type: 'announcement', title: 'No user' },
      { userId: F.stGold1.user.id, type: 'announcement', title: '' },
    ]));
    assert.equal(n, 0);
  });

  await check('markRead touches only unread rows and only their own rows', async () => {
    const first = await nid(F.stGold1.user.id);
    const moved = await forSchool(F.schoolId, (tx) => notifications.markRead(tx, F.schoolId, F.stGold1.user.id, [first!]));
    assert.equal(moved, 1);
    const again = await forSchool(F.schoolId, (tx) => notifications.markRead(tx, F.schoolId, F.stGold1.user.id, [first!]));
    assert.equal(again, 0, 'an already-read row is not touched twice');
    // Another user marking MY row id: zero moved, row stays mine and read.
    const foreign = await forSchool(F.schoolId, (tx) => notifications.markRead(tx, F.schoolId, F.gGreen.user.id, [first!]));
    assert.equal(foreign, 0);
  });

  await check('markAllRead then deleteAllRead clears the read inbox', async () => {
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGold1.user.id));
    const unread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    assert.equal(unread, 0);
    const removed = await forSchool(F.schoolId, (tx) => notifications.deleteAllRead(tx, F.schoolId, F.stGold1.user.id));
    assert.ok(removed >= 1);
  });

  console.log('── email preferences ──');
  await check('a parent with email on gets a queued email; a muted type does not', async () => {
    await forSchool(F.schoolId, (tx) => notifications.setPrefs(tx, F.schoolId, F.gGold.user.id, { emailEnabled: true, mutedTypes: ['announcement'] }));
    await forSchool(F.schoolId, (tx) => notifications.notify(tx, F.schoolId, {
      userId: F.gGold.user.id, type: 'announcement', title: 'Muted for email', body: 'x',
    }));
    const [row] = await db.select().from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.schoolId, F.schoolId), eq(schema.emailEvents.toEmail, F.gGold.user.loginId)));
    assert.ok(!row, 'a muted type queues no email');
  });

  await check('email-enabled guardians queue an email; email disabled does not', async () => {
    await forSchool(F.schoolId, (tx) => notifications.setPrefs(tx, F.schoolId, F.gGreen.user.id, { emailEnabled: false, mutedTypes: [] }));
    await forSchool(F.schoolId, (tx) => notifications.notify(tx, F.schoolId, {
      userId: F.gGreen.user.id, type: 'result_published', title: 'Result out', body: 'See the portal',
    }));
    await forSchool(F.schoolId, (tx) => notifications.notify(tx, F.schoolId, {
      userId: F.gGold.user.id, type: 'result_published', title: 'Result out', body: 'See the portal',
    }));
    const greenRows = await db.select().from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.schoolId, F.schoolId), eq(schema.emailEvents.toEmail, F.gGreen.user.loginId)));
    assert.equal(greenRows.length, 0, 'email disabled means no queue row');
    const goldRows = await db.select().from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.schoolId, F.schoolId), eq(schema.emailEvents.toEmail, F.gGold.user.loginId)));
    assert.equal(goldRows.length, 1, 'the unmuted, email-enabled guardian has exactly one queued row');
  });

  await check('placeholder and invalid addresses never queue', async () => {
    const n1 = await forSchool(F.schoolId, (tx) => email.queueEmail(tx, { schoolId: F.schoolId, to: 'not-an-email', subject: 'x', body: 'y' }));
    const n2 = await forSchool(F.schoolId, (tx) => email.queueEmail(tx, { schoolId: F.schoolId, to: 'student.1@school.invalid', subject: 'x', body: 'y' }));
    assert.equal(n1, 0); assert.equal(n2, 0);
  });

  console.log('── announcements: capability ──');
  await check('a teacher may address their own class', async () => {
    const id = await announcements.createAnnouncement(T, {
      audience: 'class', audienceRef: F.c1.id, subject: 'JSS1 Gold parents day',
      body: 'Parents day is Friday at 10am.', publish: true,
    });
    assert.ok(id > 0);
  });

  await rejects('a teacher may not address a class they do not teach', async () => {
    await announcements.createAnnouncement(T, {
      audience: 'class', audienceRef: F.c2.id, subject: 'Not my class', body: 'This must fail.', publish: false,
    });
  }, 'only address classes');

  await rejects('a teacher may not address the whole school', async () => {
    await announcements.createAnnouncement(T, {
      audience: 'school', audienceRef: null, subject: 'Whole school', body: 'This must fail.', publish: true,
    });
  }, 'cannot address');

  await rejects('a teacher may not address a role audience', async () => {
    await announcements.createAnnouncement(T, {
      audience: 'role', audienceRef: null, subject: 'All teachers', body: 'This must fail.', publish: true,
    });
  }, 'cannot address the role audience');

  await check('the deputy principal may address the whole school', async () => {
    const id = await announcements.createAnnouncement(V, {
      audience: 'school', audienceRef: null, subject: 'Resumption date',
      body: 'School resumes on the 8th of September.', publish: true,
    });
    assert.ok(id > 0);
  });

  console.log('── announcements: resolution + visibility ──');
  await check('a class announcement notifies only that class in-app', async () => {
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGold1.user.id));
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGreen1.user.id));
    await announcements.createAnnouncement(T, {
      audience: 'class', audienceRef: F.c1.id, subject: 'Gold rehearsal',
      body: 'Rehearsal at the hall at 2pm.', publish: true,
    });
    const goldUnread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    const greenUnread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGreen1.user.id));
    assert.equal(goldUnread, 1, 'the JSS1 Gold student was notified');
    assert.equal(greenUnread, 0, 'the JSS1 Green student was not');
  });

  await check('visible announcements are scoped: the Gold student sees Gold notices only', async () => {
    await announcements.createAnnouncement(TB, {
      audience: 'class', audienceRef: F.c2.id, subject: 'Green notice',
      body: 'A notice for the other class.', publish: true,
    });
    const mine = await announcements.visibleAnnouncements(actor(F.stGold1.user.id, F.schoolId, 'student', null, F.stGold1.student.id));
    const subjects = mine.map((a) => a.subject);
    assert.ok(subjects.includes('Gold rehearsal'), 'their own class notice shows');
    assert.ok(!subjects.includes('Green notice'), 'another class notice is hidden');
    assert.ok(subjects.includes('Resumption date'), 'school-wide shows');
  });

  await check('a guardian sees class notices for their child and school-wide only', async () => {
    const mine = await announcements.visibleAnnouncements(actor(F.gGold.user.id, F.schoolId, 'parent'));
    const subjects = mine.map((a) => a.subject);
    assert.ok(subjects.includes('Gold rehearsal'), 'their child’s class notice shows');
    assert.ok(!subjects.includes('Green notice'), 'another class is hidden');
  });

  await check('a teacher sees notices for their own classes only', async () => {
    const mine = await announcements.visibleAnnouncements(T);
    const subjects = mine.map((a) => a.subject);
    assert.ok(subjects.includes('Gold rehearsal'), 'their class notice shows');
    assert.ok(!subjects.includes('Green notice'), 'a colleague’s other class is hidden');
  });

  await check('drafts are invisible until published, and only leadership publishes', async () => {
    const id = await announcements.createAnnouncement(T, {
      audience: 'class', audienceRef: F.c1.id, subject: 'Draft notice',
      body: 'Nobody should see this yet.', publish: false,
    });
    const visible = await announcements.visibleAnnouncements(actor(F.stGold1.user.id, F.schoolId, 'student', null, F.stGold1.student.id));
    assert.ok(!visible.some((a) => a.subject === 'Draft notice'), 'a draft is not visible');
    await rejects('the author teacher cannot publish', async () => {
      await announcements.publishAnnouncement(T, id);
    }, 'principal or deputy');
    const moved = await announcements.publishAnnouncement(V, id);
    assert.equal(moved, 1);
    const after = await announcements.visibleAnnouncements(actor(F.stGold1.user.id, F.schoolId, 'student', null, F.stGold1.student.id));
    assert.ok(after.some((a) => a.subject === 'Draft notice'), 'published now visible');
  });

  await rejects('publishing twice is refused', async () => {
    const all = await announcements.listAnnouncements(V, 50);
    const dup = all.find((a) => a.subject === 'Resumption date')!;
    await announcements.publishAnnouncement(V, dup.id);
  }, 'already published');

  await check('a level audience resolves through classes to its students', async () => {
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGold1.user.id));
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGreen1.user.id));
    await announcements.createAnnouncement(V, {
      audience: 'level', audienceRef: F.levelId, subject: 'JSS1 excursion',
      body: 'All JSS1 classes go to the museum.', publish: true,
    });
    const a = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    const b = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGreen1.user.id));
    assert.equal(a, 1); assert.equal(b, 1);
  });

  console.log('── messages ──');
  await check('a teacher may start a thread with a guardian of their own class', async () => {
    const id = await messages.startThread(T, {
      participantUserIds: [F.gGold.user.id], subject: 'Homework concern',
      body: 'Could we discuss Tayo’s homework?',
    });
    assert.ok(id > 0);
  });

  await rejects('a teacher may not reach a guardian outside their classes', async () => {
    await messages.startThread(T, {
      participantUserIds: [F.gGreen.user.id], subject: 'Out of scope',
      body: 'This must fail.',
    });
  }, 'own classes');

  await rejects('student accounts are never valid recipients', async () => {
    await messages.startThread(T, {
      participantUserIds: [F.stGold1.user.id], subject: 'Hello student',
      body: 'This must fail.',
    });
  }, 'Student accounts');

  await rejects('nobody can message themselves', async () => {
    await messages.startThread(T, {
      participantUserIds: [F.teacher.id], subject: 'Note to self',
      body: 'This must fail.',
    });
  }, 'yourself');

  await rejects('a parent cannot open a thread', async () => {
    await messages.startThread(actor(F.gGold.user.id, F.schoolId, 'parent'), {
      participantUserIds: [F.teacherB.id], subject: 'Cold call',
      body: 'This must fail.',
    });
  }, 'staff can start');

  await rejects('recipients from another school are refused', async () => {
    await messages.startThread(T, {
      participantUserIds: [ub!.id], subject: 'Cross school',
      body: 'This must fail.',
    });
  }, 'does not exist in this school');

  await check('a reply notifies the other participant and marks the thread read', async () => {
    const id = await messages.startThread(T, {
      participantUserIds: [F.gGold.user.id], subject: 'Meeting',
      body: 'Are you free on Thursday?',
    });
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.gGold.user.id));
    const moved = await messages.replyToThread(actor(F.gGold.user.id, F.schoolId, 'parent'), id, 'Thursday at 4pm works.');
    assert.equal(moved, 1);
    const unread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.teacher.id));
    assert.ok(unread >= 1, 'the teacher was notified of the reply');
    const thread = await messages.threadMessages(actor(F.gGold.user.id, F.schoolId, 'parent'), id);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[1]!.body, 'Thursday at 4pm works.');
  });

  await rejects('a non-participant cannot read a thread', async () => {
    const id = await messages.startThread(T, {
      participantUserIds: [F.gGold.user.id], subject: 'Private',
      body: 'Just us.',
    });
    await messages.threadMessages(actor(F.gGreen.user.id, F.schoolId, 'parent'), id);
  }, 'not a participant');

  await check('myThreads lists the participant threads with unread flags', async () => {
    const threads = await messages.myThreads(actor(F.gGold.user.id, F.schoolId, 'parent'));
    assert.ok(threads.length >= 2);
    assert.ok(threads.every((t) => t.messageCount >= 1));
  });

  console.log('── email queue ──');
  await check('drain sends queued rows through the transport and marks them sent', async () => {
    const sent: string[] = [];
    const n = await forSchool(F.schoolId, (tx) => email.drainEmails(tx, 10, async (m) => {
      sent.push(m.toEmail);
    }));
    assert.ok(n >= 1, 'at least the queued result email drained');
    assert.ok(sent.includes(F.gGold.user.loginId), 'the guardian email was handed to the transport');
    const [row] = await db.select().from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.schoolId, F.schoolId), eq(schema.emailEvents.toEmail, F.gGold.user.loginId)));
    assert.equal(row!.status, 'sent');
    assert.ok(row!.sentAt, 'sent_at is recorded');
    assert.equal(row!.attempts, 1, 'the claim bumped attempts before sending');
  });

  await check('a failing transport marks the row failed with the error recorded', async () => {
    await forSchool(F.schoolId, (tx) => email.queueEmail(tx, {
      schoolId: F.schoolId, to: F.gGold.user.loginId, subject: 'Will fail', body: 'x',
    }));
    const n = await forSchool(F.schoolId, (tx) => email.drainEmails(tx, 10, async () => {
      throw new Error('SMTP connection refused');
    }));
    assert.ok(n === 0, 'nothing counted as sent');
    const [row] = await db.select().from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.schoolId, F.schoolId), eq(schema.emailEvents.subject, 'Will fail')));
    assert.equal(row!.status, 'failed');
    assert.ok(row!.lastError!.includes('SMTP connection refused'), 'the error is on the row for the office to read');
  });

  await check('queueStats reports the school’s queue shape', async () => {
    const stats = await forSchool(F.schoolId, (tx) => email.queueStats(tx, F.schoolId));
    assert.ok(stats.sent >= 1);
    assert.ok(stats.failed >= 1);
  });

  await rejects('only the principal may drain from the portal wrapper', async () => {
    await email.drainSchoolEmails(V, async () => {});
  }, 'Only the principal');

  console.log('── events emitters ──');
  await check('results publication notifies students and result-entitled guardians only', async () => {
    // Clear both cohorts first: the level-audience notice above reached both
    // JSS1 classes, so unread counts must be measured from zero.
    for (const u of [F.stGold1.user.id, F.stGreen1.user.id, F.gGold.user.id]) {
      await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, u));
    }
    const r = await forSchool(F.schoolId, (tx) => events.notifyResultsPublished(tx, F.schoolId, F.c1.id));
    assert.equal(r.students, 1, 'the one Gold student with an account');
    assert.equal(r.guardians, 1, 'the one Gold guardian entitled to results');
    const unread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGold1.user.id));
    assert.equal(unread, 1);
    const greenUnread = await forSchool(F.schoolId, (tx) => notifications.unreadCount(tx, F.schoolId, F.stGreen1.user.id));
    assert.equal(greenUnread, 0, 'publishing JSS1 Gold says nothing to JSS1 Green');
  });

  await check('promotion notification reaches the affected students', async () => {
    await forSchool(F.schoolId, (tx) => notifications.markAllRead(tx, F.schoolId, F.stGold1.user.id));
    const n = await forSchool(F.schoolId, (tx) => events.notifyPromotionApproved(tx, F.schoolId, [F.stGold1.student.id]));
    assert.equal(n, 1);
  });

  console.log('── cross-tenant ──');
  await check('another school sees none of the announcements or threads', async () => {
    const visible = await announcements.visibleAnnouncements(B);
    assert.equal(visible.length, 0);
    const threads = await messages.myThreads(B);
    assert.equal(threads.length, 0);
  });

  await rejects('another school’s principal cannot publish our drafts', async () => {
    const all = await announcements.listAnnouncements(V, 50);
    const target = all.find((a) => a.status === 'draft') ?? all[0]!;
    await announcements.publishAnnouncement(B, target.id);
  });

  console.log('── RLS (fail closed) ──');
  await check('a tenantless connection sees no communications rows', async () => {
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
    try {
      const tables = ['notifications', 'notification_prefs', 'announcements', 'message_threads', 'thread_participants', 'messages', 'email_events'];
      for (const table of tables) {
        const rows = await app`select count(*)::int as n from ${app(table)}`;
        assert.equal(rows[0]!.n, 0, `tenantless sees zero rows in ${table}`);
      }
    } finally {
      await app.end();
    }
  });

  console.log(`\nCOMMS OK: ${count} checks passed.`);
  await owner.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
