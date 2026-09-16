import { createSession } from '@/lib/auth/session-store';
import { db } from '@/db';

const BASE = 'http://127.0.0.1:3023';
const PRINCIPAL_USER_ID = 1; // school 1, richer seed data (staff, subjects, classes)

async function main() {
  const { chromium } = await import('/tmp/educbt-browser/node_modules/playwright/index.mjs' as any);
  const { token } = await createSession(PRINCIPAL_USER_ID, '127.0.0.1', 'bugreport-script');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'educbt.session', value: token, url: BASE }]);
  const page = await context.newPage();

  const shot = async (path: string, file: string, actions?: () => Promise<void>) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch((e: unknown) => console.error('nav fail', path, e));
    if (actions) await actions();
    await page.screenshot({ path: `/tmp/bug-${file}.png`, fullPage: true });
    console.log('shot', file, 'ok');
  };

  await shot('/portal/activity', 'activity');
  await shot('/portal/promotion', 'promotion');
  await shot('/portal/transcripts', 'transcripts');
  await shot('/portal/broadsheet?class=1', 'broadsheet');
  await shot('/portal/results', 'results');

  // Subjects: click Edit on the first row
  await shot('/portal/subjects', 'subjects-edit', async () => {
    const btn = page.locator('table.sa-table button:has-text("Edit")').first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); }
  });

  // Classes: click Edit on the first row
  await shot('/portal/classes', 'classes-edit', async () => {
    const btn = page.locator('table.sa-table button:has-text("Edit")').first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); }
  });

  // Staff: assign-duties form + click Edit on first staff row (reference)
  await shot('/portal/staff', 'staff-page', async () => {
    const btn = page.locator('table.sa-table button:has-text("Edit")').first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); }
  });

  await browser.close();
  const dbAny = db as unknown as { $client?: { end?: () => Promise<void> } };
  await dbAny.$client?.end?.();
  console.log('done');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
