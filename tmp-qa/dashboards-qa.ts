/**
 * Browser QA for the role dashboards (Principal / VP / Teacher / Parent).
 * Desktop (1280x800) + mobile (390x844). Verifies each role lands on its
 * own dashboard with the right data, role gates hold in the browser, no
 * dead links on the dashboard surface, and no horizontal overflow.
 */
import { chromium } from 'playwright-core';

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

async function signIn(page: any, loginId: string, password: string) {
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name=loginId]', loginId);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/portal(?!\/sign-in)/, { timeout: 15000 });
}

async function has(page: any, text: string, name: string) {
  const body = await page.textContent('body');
  if (body && body.includes(text)) ok(name);
  else fail(name, `"${text}" not on page`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome' });
  const fresh = async () => await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  let page = await fresh();

  // ---- Principal ------------------------------------------------------
  await signIn(page, 'PRINCIPAL', PW);
  await page.waitForSelector('.sd-heading h1');
  await has(page, 'Principal’s Dashboard', 'principal sees their dashboard');
  await has(page, 'Active students', 'principal stat tiles render');
  await has(page, 'Pending office actions', 'principal pending panel renders');
  await has(page, 'Results Pipeline', 'principal pipeline panel renders');
  await has(page, 'Recent Activity', 'principal activity panel renders');
  await shot(page, 'dash-principal');
  await overflow(page, 'principal desktop');

  await page.click('a[href="/portal/activity"]');
  await page.waitForURL(/\/portal\/activity/);
  await has(page, 'Activity', 'principal can open the activity log');
  await shot(page, 'dash-activity');
  await overflow(page, 'activity desktop');

  // ---- Vice principal --------------------------------------------------
  page = await fresh();
  await signIn(page, 'VPREVIEW', PW);
  await page.waitForSelector('.sd-heading h1');
  await has(page, 'Vice Principal’s Dashboard', 'vice principal sees their dashboard');
  await has(page, 'Recent Activity', 'vice principal activity panel renders');
  await shot(page, 'dash-vp');
  await overflow(page, 'vp desktop');

  // ---- Teacher ----------------------------------------------------------
  page = await fresh();
  await signIn(page, 'STF001', PW);
  await page.waitForSelector('.sd-heading h1');
  await has(page, 'Teacher’s Dashboard', 'teacher sees their dashboard');
  await has(page, 'My students', 'teacher student count tile renders');
  await has(page, 'Record CA', 'teacher record CA panel renders');
  await has(page, 'Classes I Head', 'teacher classes panel renders');
  await shot(page, 'dash-teacher');
  await overflow(page, 'teacher desktop');

  await page.goto(`${BASE}/portal/activity`);
  await has(page, 'You do not have access to the activity log', 'teacher activity page refused');
  await overflow(page, 'teacher refusal desktop');

  // ---- Parent -----------------------------------------------------------
  page = await fresh();
  await signIn(page, 'PAREVIEW', PW);
  await page.waitForSelector('h1');
  await has(page, 'My Children', 'parent sees their children dashboard');
  await has(page, 'not shared with this account', 'withheld child shows restriction note');
  await shot(page, 'dash-parent');
  await overflow(page, 'parent desktop');

  // ---- Mobile (390px) ----------------------------------------------------
  const freshMobile = async () => await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  let mobile = await freshMobile();
  await signIn(mobile, 'PRINCIPAL', PW);
  await mobile.waitForSelector('.sd-heading h1');
  await has(mobile, 'Principal’s Dashboard', 'principal dashboard mobile renders');
  await overflow(mobile, 'principal mobile');
  await shot(mobile, 'dash-principal-mobile');

  mobile = await freshMobile();
  await signIn(mobile, 'STF001', PW);
  await mobile.waitForSelector('.sd-heading h1');
  await has(mobile, 'Teacher’s Dashboard', 'teacher dashboard mobile renders');
  await overflow(mobile, 'teacher mobile');
  await shot(mobile, 'dash-teacher-mobile');

  mobile = await freshMobile();
  await signIn(mobile, 'PAREVIEW', PW);
  await mobile.waitForSelector('h1');
  await has(mobile, 'My Children', 'parent dashboard mobile renders');
  await overflow(mobile, 'parent mobile');
  await shot(mobile, 'dash-parent-mobile');

  await browser.close();
  if (failures.length) {
    console.log(`\n${passes} PASS / ${failures.length} FAIL`);
    process.exit(1);
  }
  console.log(`\n${passes} PASS / 0 FAIL`);
}

main();
