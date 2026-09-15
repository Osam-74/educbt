/**
 * Browser QA for the platform Managers screen (real form + server actions).
 * Signs in as PLATFORM-ADMIN by injecting a NON-SECURE session cookie
 * (the local http server sets `secure` cookies Chromium won't replay).
 *
 * Run: tsx tmp-qa/managers-qa.ts   (server on :3010, DATABASE_URL -> CA test db)
 */
import postgres from 'postgres';
import { chromium } from 'playwright-core';
import { createSession } from '@/lib/auth/session-store';

const BASE = process.env.QA_BASE ?? 'http://localhost:3010';
const SHOTS = '/app/conversations/6aa0f8fb35533b8915a1d696/tmp-qa/shots';

let passes = 0;
const failures: string[] = [];
const ok = (n: string) => { passes++; console.log(`PASS ${n}`); };
const fail = (n: string, why: string) => { failures.push(`${n}: ${why}`); console.log(`FAIL ${n}: ${why}`); };

async function main() {
  const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
  const [{ id: adminId }] = (await owner`SELECT id FROM users WHERE login_id = 'PLATFORM-ADMIN' AND school_id IS NULL LIMIT 1`) as { id: number }[];
  const { token } = await createSession(adminId, null, 'qa-managers');
  await owner.end();

  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'educbt.session', value: token, url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. dashboard + nav item
  await page.goto(`${BASE}/platform`, { waitUntil: 'networkidle' });
  const navManagers = page.locator('a[href="/platform/managers"]');
  (await navManagers.count()) >= 1 ? ok('Managers is in the sidebar nav') : fail('nav', 'no /platform/managers link');

  // 2. the page itself
  await page.goto(`${BASE}/platform/managers`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#managers-table', { timeout: 8000 });
  ok('managers page renders the directory');
  (await page.locator('#managers-table strong:has-text("PLATFORM-ADMIN")').count()) >= 1
    ? ok('the acting admin is listed')
    : fail('directory', 'PLATFORM-ADMIN not in table');
  (await page.locator('#managers-table .pa-pill:has-text("You")').count()) === 1
    ? ok('the acting admin is marked "You"')
    : fail('you-pill', 'no You pill');
  (await page.locator('#managers-table td:has-text("Current session")').count()) === 1
    ? ok('own row offers no suspend control')
    : fail('self-row', 'own row has an action form');
  (await page.locator('#create-manager-form').count()) === 1
    ? ok('the create form is present')
    : fail('form', 'create-manager-form missing');
  (await page.locator('h1:has-text("Managers")').count()) === 1 ? ok('page heading present') : fail('h1', 'missing');
  await page.screenshot({ path: `${SHOTS}/managers-1-directory.png`, fullPage: true });

  // 3. create a manager through the real form
  const mgrLogin = `QA-MGR-${Date.now() % 100000}`;
  await page.fill('#manager-login-id', mgrLogin);
  await page.fill('#manager-email', `qa-${mgrLogin.toLowerCase()}@example.com`);
  await page.click('#submit-create-manager-btn');
  await page.waitForSelector('#manager-created-success', { timeout: 15000 });
  ok('create action returns the success card');
  const shownLogin = await page.locator('[data-testid="manager-login-id"]').textContent();
  shownLogin === mgrLogin ? ok('success card shows the chosen sign-in ID') : fail('success-login', `got ${shownLogin}`);
  const tempPwd = (await page.locator('[data-testid="temp-password"]').textContent()) ?? '';
  tempPwd.length >= 12 ? ok(`success card shows the one-time password (${tempPwd.length} chars)`) : fail('temp-pwd', 'missing/short');
  (await page.locator('.pa-cred-onetime:has-text("One-time view")').count()) === 1
    ? ok('the credential card is marked one-time view')
    : fail('onetime-badge', 'missing');
  await page.screenshot({ path: `${SHOTS}/managers-2-created.png`, fullPage: true });

  // 4. the new manager appears in the directory (after "Add another" reset)
  await page.click('#manager-created-done-btn');
  await page.waitForSelector('#create-manager-form', { timeout: 8000 });
  ok('"Add another manager" resets the form (credential gone)');
  const row = page.locator(`#managers-table tr:has-text("${mgrLogin}")`);
  (await row.count()) === 1 ? ok('new manager appears in the directory') : fail('row', 'not listed');
  (await row.locator('.pa-pill--active').count()) === 1 ? ok('new manager is active') : fail('status', 'not active pill');
  (await row.locator('text=Not set up').count()) === 1 ? ok('TOTP shows "Not set up"') : fail('totp', 'expected Not set up');

  // 5. suspend / reactivate via the row form
  await row.locator('button:has-text("Suspend")').click();
  await page.waitForSelector(`#managers-table tr:has-text("${mgrLogin}") .pa-pill--suspended`, { timeout: 10000 });
  ok('suspend flips the row to suspended');
  await page.screenshot({ path: `${SHOTS}/managers-3-suspended.png`, fullPage: true });
  await page.locator(`#managers-table tr:has-text("${mgrLogin}") button:has-text("Reactivate")`).click();
  await page.waitForSelector(`#managers-table tr:has-text("${mgrLogin}") .pa-pill--active`, { timeout: 10000 });
  ok('reactivate flips the row back to active');

  // 6. duplicate sign-in ID -> plain field-level error
  await page.fill('#manager-login-id', mgrLogin);
  await page.fill('#manager-email', '');
  await page.click('#submit-create-manager-btn');
  await page.waitForSelector('.pa-alert--error', { timeout: 15000 });
  const errMsg = (await page.locator('.pa-alert--error').first().textContent()) ?? '';
  errMsg.includes('already used') && errMsg.includes(mgrLogin)
    ? ok('duplicate ID gets a plain error message')
    : fail('dup-error', `message: ${errMsg.trim().slice(0, 80)}`);
  (await page.locator('.pa-field-error').count()) >= 1
    ? ok('field-level error is shown under the input')
    : fail('field-error', 'no field error');

  // 7. empty sign-in ID -> generates one
  await page.goto(`${BASE}/platform/managers`, { waitUntil: 'networkidle' });
  await page.fill('#manager-login-id', '');
  await page.fill('#manager-email', '');
  await page.click('#submit-create-manager-btn');
  await page.waitForSelector('#manager-created-success', { timeout: 15000 });
  const genLogin = (await page.locator('[data-testid="manager-login-id"]').textContent()) ?? '';
  /^PLATFORM-ADMIN-\d+$/.test(genLogin)
    ? ok(`empty ID generates the next free one (${genLogin})`)
    : fail('gen-id', `got ${genLogin}`);

  // 8. cleanup the QA managers
  const cleanup = postgres(process.env.DATABASE_URL!, { max: 1 });
  await cleanup`DELETE FROM users WHERE login_id IN (${mgrLogin}, ${genLogin}) AND school_id IS NULL AND role = 'platform_admin'`;
  await cleanup.end();
  ok('QA managers cleaned up');

  errors.length === 0 ? ok('no page errors during the run') : fail('page-errors', errors.join(' | ').slice(0, 120));

  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : `\nAll ${passes} managers checks passed.`);
  process.exit(failures.length ? 1 : 0);
}
main();
