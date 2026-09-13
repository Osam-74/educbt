/**
 * Browser QA for the communications pages (desktop 1280x800 and mobile
 * 390x844). Signs in as the demo PRINCIPAL, STF001 (teacher) and PAREVIEW
 * (parent) and walks, with real clicks:
 *
 *   principal: unread badge → notifications inbox → mark-all-read →
 *              compose + publish a school announcement → start a message
 *              thread with the parent
 *   teacher:   messages page offers only own-class guardians → compose a
 *              class announcement (their class alone)
 *   parent:    announcements board → reply to the thread → notifications
 *
 * Run from educbt/ with the seeded CA test DB running and the app on :3017:
 *   DATABASE_URL_UNPOOLED=... npx tsx tmp-qa/comms-qa.ts
 * Needs the full playwright package at /tmp/educbt-browser.
 */
import { chromium } from '/tmp/educbt-browser/node_modules/playwright/index.mjs';

const BASE = 'http://demo.localhost:3017';
const PW = 'Qa-Baseline-2026!';
const SHOTS = '/app/conversations/6aa0f8fb35533b8915a1d696/tmp-qa/shots';
const failures: string[] = [];
let passes = 0;

function ok(name: string) { passes++; console.log(`PASS ${name}`); }
function fail(name: string, why: string) { failures.push(`${name}: ${why}`); console.log(`FAIL ${name}: ${why}`); }

async function overflow(page: any, name: string) {
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) fail(`overflow ${name}`, `${over}px horizontal overflow`);
  else ok(`overflow ${name}`);
}

async function shot(page: any, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function signIn(page: any, loginId: string) {
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name=loginId]', loginId);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/portal/, { timeout: 20000 });
}

async function status(page: any, fragment: string, name: string, timeout = 20000) {
  try {
    await page.waitForFunction(
      (f: string) => Array.from(document.querySelectorAll('[role=status]'))
        .some((p) => (p.textContent || '').includes(f)),
      fragment, { timeout });
    ok(name);
  } catch {
    const texts = await page.$$eval('[role=status],[role=alert]', els => els.map(e => e.textContent));
    fail(name, `no status containing "${fragment}" (statuses: ${JSON.stringify(texts)})`);
  }
}

async function text(page: any, fragment: string, name: string) {
  const body = await page.content();
  if (body.includes(fragment)) ok(name);
  else fail(name, `"${fragment}" not on page`);
}

async function noText(page: any, fragment: string, name: string) {
  const body = await page.content();
  if (!body.includes(fragment)) ok(name);
  else fail(name, `"${fragment}" unexpectedly on page`);
}

async function main() {
  const browser = await chromium.launch();

  // ── Desktop: PRINCIPAL ───────────────────────────────────────────────────
  let page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await signIn(page, 'PRINCIPAL');
  ok('principal signs in');

  // 1. The shell badge reports unread notifications.
  await page.goto(`${BASE}/portal/notifications`);
  const badge = await page.textContent('.ps-badge').catch(() => null);
  if (badge && Number(badge) >= 1) ok('shell shows the unread badge');
  else fail('shell shows the unread badge', `badge text: ${badge}`);

  // 2. Inbox shows the seeded notices, newest first.
  await text(page, 'QA notice: results are out', 'inbox lists the seeded notices');
  await text(page, 'Mark all as read', 'mark-all control renders');
  await shot(page, 'comms-notifications');
  await overflow(page, 'notifications desktop');

  // 3. Mark all read clears the badge.
  await page.click('text=Mark all as read');
  await page.waitForLoadState('networkidle');
  const badgeAfter = await page.textContent('.ps-badge').catch(() => null);
  if (badgeAfter === null || Number(badgeAfter) === 0) ok('mark-all-read clears the badge');
  else fail('mark-all-read clears the badge', `badge still shows ${badgeAfter}`);

  // 4. Compose + publish a school-wide announcement.
  await page.goto(`${BASE}/portal/announcements`);
  await text(page, 'QA Resumption notice', 'published announcement is on the board');
  await text(page, 'QA Class draft', 'draft is listed for leadership');
  await page.fill('input[name=subject]', 'QA Browser announcement');
  await page.fill('textarea[name=body]', 'A school-wide notice posted from the browser QA run.');
  await page.selectOption('select[name=audience]', 'school');
  await page.click('button:has-text("Save announcement")');
  await status(page, 'Announcement saved', 'compose announces success');
  await text(page, 'QA Browser announcement', 'posted announcement appears on the board');
  await shot(page, 'comms-announcements');
  await overflow(page, 'announcements desktop');

  // 5. Publish the teacher's draft from the "my announcements" table.
  const draftRow = page.locator('tr:has-text("QA Class draft")');
  if (await draftRow.count()) {
    await draftRow.locator('form button').click();
    await status(page, 'Announcement published', 'publish action confirms');
    const cell = await draftRow.locator('td:nth-child(3)').textContent().catch(() => null);
    if (cell && cell.trim() === 'published') ok('draft publish flow works');
    else fail('draft publish flow works', `status cell: ${cell}`);
  } else {
    fail('draft publish flow works', 'draft row not found');
  }

  // 6. Start a message thread with the parent.
  await page.goto(`${BASE}/portal/messages`);
  await page.fill('input[name=subject]', 'QA thread from principal');
  await page.fill('textarea[name=body]', 'Hello — quick note from the browser QA run.');
  await page.selectOption('select[name=participants]', { label: 'Parent Review (guardian)' });
  await page.click('button:has-text("Send message")');
  await status(page, 'Message sent', 'compose announces success');
  await text(page, 'QA thread from principal', 'thread appears after compose');
  await page.click('text=QA thread from principal');
  await page.waitForLoadState('networkidle');
  await text(page, 'quick note from the browser QA run', 'first message renders in the thread');
  await shot(page, 'comms-messages-principal');
  await overflow(page, 'messages desktop');

  // ── Desktop: STF001 (teacher, fresh context) ────────────────────────────
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await signIn(page, 'STF001');
  ok('teacher signs in');

  await page.goto(`${BASE}/portal/messages`);
  const composeSel = await page.$('select[name=participants]');
  if (composeSel) {
    const options = await composeSel.$$eval('option', (os: any[]) => os.map((o) => o.textContent));
    if (options.some((o: string) => o!.includes('Parent Review'))) ok('teacher compose lists own-class guardian');
    else fail('teacher compose lists own-class guardian', `options: ${JSON.stringify(options)}`);
    if (options.some((o: string) => o!.includes('Samuel Okonkwo'))) ok('staff can message staff colleagues');
    else fail('staff can message staff colleagues', `options: ${JSON.stringify(options)}`);
  } else {
    fail('teacher compose lists own-class guardian', 'compose form missing');
  }

  // Compose restricted to their class.
  await page.goto(`${BASE}/portal/announcements`);
  const audienceSel = await page.$('select[name=audience]');
  if (audienceSel) {
    const values = await audienceSel.$$eval('option', (os: any[]) => os.map((o) => o.value));
    if (values.includes('class') && !values.includes('school')) ok('teacher audience is restricted to class');
    else fail('teacher audience is restricted to class', `audiences: ${JSON.stringify(values)}`);
    await page.fill('input[name=subject]', 'QA teacher class notice');
    await page.fill('textarea[name=body]', 'A notice posted by the teacher to their own class.');
    await page.selectOption('select[name=audience]', 'class');
    const klassSel = await page.$('select[name=audienceRef]');
    if (klassSel) {
      const kopts = await klassSel.$$eval('option', (os: any[]) => os.map((o) => o.textContent));
      if (kopts.length === 1) ok('class choices are only their own');
      else fail('class choices are only their own', `classes: ${JSON.stringify(kopts)}`);
    }
    await page.click('button:has-text("Save announcement")');
    await status(page, 'Announcement saved', 'teacher compose announces success');
    await text(page, 'QA teacher class notice', 'teacher class announcement posts');
  } else {
    fail('teacher audience is restricted to class', 'compose form missing');
  }

  // ── Desktop: PAREVIEW (parent, fresh context) ───────────────────────────
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await signIn(page, 'PAREVIEW');
  ok('parent signs in');

  // Board: school-wide + own-child-class notices visible.
  await page.goto(`${BASE}/portal/announcements`);
  await text(page, 'QA Resumption notice', 'parent sees the school-wide announcement');
  await text(page, 'QA Browser announcement', 'parent sees the newer school-wide announcement');
  await text(page, 'QA teacher class notice', 'parent sees their child class notice');

  // Notifications seeded for the parent.
  await page.goto(`${BASE}/portal/notifications`);
  await text(page, 'QA notice: you have a message', 'parent inbox shows the seeded notice');
  await shot(page, 'comms-notifications-parent');

  // Reply to the principal's thread.
  await page.goto(`${BASE}/portal/messages`);
  await page.click('text=QA thread from principal');
  await page.waitForLoadState('networkidle');
  await page.fill('textarea[name=body]', 'Thank you — noted from the QA run.');
  await page.click('button:has-text("Send reply")');
  await status(page, 'Reply sent', 'reply announces success');
  await text(page, 'Thank you — noted from the QA run.', 'parent reply lands in the thread');
  await shot(page, 'comms-messages-parent');

  // Preferences persist.
  await page.goto(`${BASE}/portal/notifications`);
  await page.check('input[name=emailEnabled]').catch(() => {});
  await page.click('button:has-text("Save preferences")').catch(() => {});
  await page.waitForLoadState('networkidle');
  await shot(page, 'comms-prefs-parent');

  // ── Mobile: parent at 390px ──────────────────────────────────────────────
  const mob = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(mob, 'PAREVIEW');
  await mob.goto(`${BASE}/portal/notifications`);
  await overflow(mob, 'notifications mobile');
  await mob.goto(`${BASE}/portal/announcements`);
  await overflow(mob, 'announcements mobile');
  await mob.goto(`${BASE}/portal/messages`);
  await overflow(mob, 'messages mobile');
  await shot(mob, 'comms-messages-mobile');

  await browser.close();
  if (failures.length) {
    console.log(`\nCOMMS QA: ${passes} passed, ${failures.length} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nCOMMS QA: all ${passes} checks passed.`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
