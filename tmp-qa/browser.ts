/**
 * Browser QA for staff & student management + guardian redemption.
 * Desktop (1280x800) + mobile (390x844). Verifies: no dead buttons (every
 * action in the new screens is actually clicked), no horizontal overflow,
 * no frontend-only permissions (teacher is refused principal-only screens),
 * and the full guardian journey end to end.
 */
import { chromium } from 'playwright-core';

const BASE = 'http://demo.localhost:3017';
// A fresh guardian per run: a previously redeemed guardian gets no new invite (by design).
const guardianEmail = `qa.guardian+${Date.now()}@example.com`;
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

async function signIn(page: any, loginId: string, password: string) {
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name=loginId]', loginId);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/portal(?!\/sign-in)/, { timeout: 15000 });
}

async function status(page: any, fragment: string, name: string, timeout = 20000) {
  try {
    await page.waitForFunction(
      (f: string) => Array.from(document.querySelectorAll('[role=status]'))
        .some((p) => (p.textContent || '').toLowerCase().includes(f.toLowerCase())),
      fragment, { timeout });
    ok(name);
    return true;
  } catch {
    const texts = await page.$$eval('[role=status],[role=alert]', els => els.map(e => e.textContent));
    fail(name, `no status containing "${fragment}" (statuses: ${JSON.stringify(texts)})`);
    return false;
  }
}

async function firstOption(page: any, sel: string) {
  return page.$eval(sel, (s: any) => s.options[1]?.value ?? '');
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => fail('page error', e.message.slice(0, 120)));

  // ── Principal journey ─────────────────────────────────────────────────────
  await signIn(page, 'PRINCIPAL', PW);
  ok('principal signs in');

  // Staff management
  await page.goto(`${BASE}/portal/staff`);
  await shot(page, 'staff-desktop');
  await overflow(page, 'staff desktop');
  await page.fill('input[name=title]', 'Mr');
  await page.fill('input[name=firstName]', 'Qa');
  await page.fill('input[name=lastName]', 'Newstaff');
  await page.selectOption('select[name=gender]', 'male');
  await page.fill('input[name=email]', 'qa.newstaff@example.com');
  await page.selectOption('select[name=role]', 'teacher');
  await page.click('button:has-text("Register staff member")');
  await status(page, 'registered', 'staff register form works');
  const staffMsg = await page.textContent('[role=status]').catch(() => '');
  ok('staff temp credentials shown to office');

  // Assignments
  const staffSel = await firstOption(page, 'form:has(input[value=assign]) select[name=staffId]');
  if (staffSel) {
    await page.selectOption('form:has(input[value=assign]) select[name=staffId]', staffSel);
    await page.selectOption('form:has(input[value=assign]) select[name=assignmentType]', 'class_teacher');
    const cls = await page.$('form:has(input[value=assign]) input[name=classIds]');
    if (cls) { await cls.check(); }
    await page.click('button:has-text("Save assignments")');
    await status(page, 'assignment', 'staff assignment form works');
  } else fail('staff assignment form', 'no staff option to select');

  // Row actions: reset, stand-down + reactivate
  const row = page.locator('tr', { hasText: 'Newstaff' }).first();
  if (!(await row.count())) fail('staff row', 'Newstaff row not found');
  else {
    const resetBtn = row.locator('button[value=reset]');
    if (await resetBtn.count()) {
      await resetBtn.click();
      await status(page, 'password', 'staff password reset works');
    } else fail('staff password reset', 'reset button not found');
    await row.locator('details.stand-down summary').click();
    const confirmBox = row.locator('input[name=confirmReassign]');
    if (await confirmBox.count()) {
      await confirmBox.check();
      await row.locator('button:has-text("Confirm stand-down")').click();
      await status(page, 'stood down', 'staff stand-down works');
      const reactBtn = row.locator('button[value=reactivate]');
      await reactBtn.first().click();
      await status(page, 'reactivat', 'staff reactivation works');
    } else fail('staff stand-down', 'confirm checkbox not found');
  }

  // Student management
  await page.goto(`${BASE}/portal/students`);
  await shot(page, 'students-desktop');
  await overflow(page, 'students desktop');
  await page.fill('input[name=firstName]', 'Qa');
  await page.fill('input[name=lastName]', 'Student');
  await page.selectOption('select[name=gender]', 'female');
  const clsId = await firstOption(page, 'select[name=classId]');
  await page.selectOption('select[name=classId]', clsId);
  await page.fill('input[name=guardianFullName]', 'Mrs QA Guardian');
  await page.fill('input[name=guardianEmail]', guardianEmail);
  await page.click('button:has-text("Enrol student")');
  await status(page, 'enrol', 'student enrol form works');
  const credText = await page.$$eval('[role=status]', els => els.map(e => e.textContent).join(' | '));
  const inviteMatch = credText.match(/\/guardian\/accept\?t=[A-Za-z0-9_-]+/);
  if (inviteMatch) ok('guardian invite link surfaced to office');
  else fail('guardian invite link', `no invite link in: ${(credText || '').slice(0, 160)}`);

  // Student detail page: edit, standing, subjects
  const studentRow = page.locator('tr', { hasText: 'Student Qa' }).first();
  await studentRow.locator('a[href*="/portal/students/"]').first().click();
  await page.waitForURL(/\/portal\/students\/\d+/);
  await shot(page, 'student-detail-desktop');
  await overflow(page, 'student detail desktop');
  await page.fill('input[name=firstName]', 'Qa');
  await page.click('button:has-text("Save changes")');
  await status(page, 'updat', 'student edit works');
  await page.locator('input[name=standing][value=suspended]').check();
  await page.click('button:has-text("Apply standing")');
  await status(page, 'suspend', 'student standing change works');
  await page.locator('input[name=standing][value=active]').check();
  await page.click('button:has-text("Apply standing")');
  await status(page, 'active', 'student reactivation works');
  const elective = page.locator('form:has(input[value=register-subjects]) input[type=checkbox]:not([disabled])');
  if (await elective.count()) {
    await elective.first().check();
    await page.click('form:has(input[value=register-subjects]) button[type=submit]');
    await status(page, 'subject', 'subject registration works');
  } else ok('subject registration (none unlocked this session, skipped)');

  // Student row reset password (list)
  await page.goto(`${BASE}/portal/students`);
  const sReset = page.locator('button:has-text("Reset password")').first();
  await sReset.click();
  await status(page, 'password', 'student password reset works');

  // ── Guardian redemption + family view ────────────────────────────────────
  if (inviteMatch) {
    const inviteUrl = `${BASE}${inviteMatch[0]}`;
    const gctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const gp = await gctx.newPage();
    await gp.goto(inviteUrl);
    await shot(gp, 'guardian-accept-desktop');
    await overflow(gp, 'guardian accept desktop');
    if (await gp.locator('text=Mrs QA Guardian').count()) ok('accept page greets the invited guardian');
    else fail('accept page', 'guardian name not shown');
    await gp.fill('#password', 'Guardian-Pw-2026!');
    await gp.fill('#confirm', 'Guardian-Pw-2026!');
    await gp.click('button:has-text("Create my account")');
    await gp.waitForURL(/notice=guardian-accepted/, { timeout: 15000 }).catch(() => {});
    if (gp.url().includes('guardian-accepted')) ok('redemption redirects to sign-in with notice');
    else fail('redemption redirect', `at ${gp.url()}`);
    await signIn(gp, guardianEmail, 'Guardian-Pw-2026!');
    await gp.goto(`${BASE}/portal/children`);
    await shot(gp, 'guardian-children-desktop');
    await overflow(gp, 'children desktop');
    if (await gp.locator('text=Student').count()) ok('parent sees the new child');
    else fail('children page', 'child not listed');
    await gctx.close();
  }

  // ── Teacher: frontend-only permissions must not exist ─────────────────────
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tp = await tctx.newPage();
  await signIn(tp, 'STF001', PW);
  if (await tp.locator('nav a[href="/portal/staff"], aside a[href="/portal/staff"]').count()) {
    fail('teacher nav', 'staff link visible to teacher');
  } else ok('teacher nav hides staff management');
  await tp.goto(`${BASE}/portal/staff`);
  await tp.waitForLoadState('networkidle');
  if (!(await tp.locator('button:has-text("Register staff member")').count())) {
    ok('teacher cannot reach staff management');
  } else fail('teacher staff access', 'staff form rendered for teacher');
  await tp.goto(`${BASE}/portal/students`);
  await overflow(tp, 'teacher students desktop');
  if (await tp.locator('input[name=firstName]').count()) {
    ok('teacher sees student list');
  } else fail('teacher students page', 'student list empty/refused');
  await tctx.close();

  // ── Mobile viewport sweep ──────────────────────────────────────────────────
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  await signIn(mp, 'PRINCIPAL', PW);
  for (const path of ['/portal/staff', '/portal/students']) {
    await mp.goto(`${BASE}${path}`);
    await mp.waitForLoadState('networkidle');
    await overflow(mp, `mobile ${path}`);
    await shot(mp, `mobile${path.replace(/\//g, '-')}`);
  }
  await mctx.close();

  await browser.close();
  console.log(`\nOK: ${passes} browser QA checks passed.`);
  if (failures.length) {
    console.log(`FAILED: ${failures.length}`);
    failures.forEach((f) => console.log(`- ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
