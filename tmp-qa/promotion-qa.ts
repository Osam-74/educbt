/**
 * Browser QA for the promotion + transcript offices (desktop 1280x800 and
 * mobile 390x844). Signs in as the demo PRINCIPAL and walks, with real clicks:
 *
 *   propose → bulk override → commit → issue transcript → print the document
 *   (chromium print-to-PDF, page count asserted) → public verify (genuine,
 *   wrong code) → reverse the promotion → teacher redirect.
 *
 * Run from educbt/ with the seeded CA test DB running and the app on :3017:
 *   DATABASE_URL_UNPOOLED=... npx tsx tmp-qa/promotion-qa.ts
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
    return true;
  } catch {
    const texts = await page.$$eval('[role=status],[role=alert]', els => els.map(e => e.textContent));
    fail(name, `no status containing "${fragment}" (statuses: ${JSON.stringify(texts)})`);
    return false;
  }
}

async function selectByLabel(page: any, name: string, label: string) {
  await page.selectOption(`select[name=${name}]`, { label });
}

async function main() {
  const browser = await chromium.launch();

  // ── Desktop ─────────────────────────────────────────────────────────────
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

  await signIn(page, 'PRINCIPAL');
  ok('principal signs in');

  // 1. Propose a batch for the QA level.
  await page.goto(`${BASE}/portal/promotion`);
  await selectByLabel(page, 'fromSessionId', 'QA 2024/25');
  await selectByLabel(page, 'toSessionId', 'QA 2025/26');
  await selectByLabel(page, 'levelId', 'QA Promote One');
  await page.click('text=Evaluate level');
  await status(page, 'Proposal created', 'propose flow creates a proposal');
  await shot(page, 'promotion-review');

  // 2. Bulk override the promotable student to trial, with a written reason.
  await page.check('input[type=checkbox]');
  await selectByLabel(page, 'outcome', 'Promote on trial');
  await page.fill('input[name=reason]', 'Browser QA override with a long enough reason.');
  await page.click('text=Apply to selected');
  await status(page, 'Decision recorded for 1', 'bulk override with a reason is applied');

  // 3. Commit.
  await page.click('text=Commit promotion');
  await status(page, 'Promotion committed', 'principal commits the promotion');
  await shot(page, 'promotion-committed');

  // 4. The transcript office: load the student, issue, open the document.
  await page.goto(`${BASE}/portal/transcripts`);
  await page.fill('input[name=student]', 'QA/PROMO');
  await page.click('text=Load student');
  await page.waitForSelector('text=Cumulative average');
  ok('transcript office loads the student summary');
  await page.click('text=Issue transcript');
  await status(page, 'recorded', 'transcript issuance is recorded');
  await page.waitForSelector('a[href*="/portal/transcripts/"]');
  await page.click('a[href*="/portal/transcripts/"]');
  await page.waitForSelector('text=Academic Transcript');
  ok('the issued document renders');
  const body = await page.textContent('body');
  if (!body || !body.includes('OFFICIAL COPY')) fail('document watermark', 'OFFICIAL COPY missing');
  else ok('document carries the OFFICIAL COPY watermark');
  const serial = (body || '').match(/[A-Z0-9]+\/TR\/\d{4}\/\d{4}/)?.[0] ?? '';
  const code = (body || '').match(/Verification code:\s*([0-9a-f]{10})/)?.[1] ?? '';
  if (!serial) fail('document serial', 'serial not found on the page');
  else ok('document carries its serial');
  if (!code) fail('document code', 'verification code not found');
  else ok('document carries the verification code');
  await shot(page, 'transcript-document');

  // 5. Print pipeline: chromium print-to-PDF, page count asserted.
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  const pages = (pdf.toString('binary').match(/\/Type[\s]*\/Page[^s]/g) || []).length;
  if (pages < 1 || pages > 3) fail('document print', `printed ${pages} pages, expected 1-3`);
  else ok(`document prints on ${pages} page(s)`);

  // 6. Public verification — genuine, then a wrong code.
  await page.goto(`${BASE}/verify/transcript?serial=${encodeURIComponent(serial)}&code=${code}`);
  await page.waitForSelector('text=Genuine');
  ok('public verify confirms the genuine copy');
  await page.goto(`${BASE}/verify/transcript?serial=${encodeURIComponent(serial)}&code=deadbeef00`);
  await page.waitForSelector('text=Not verified');
  ok('a wrong code is refused publicly');
  await shot(page, 'verify-transcript');

  // 7. Reverse the committed promotion.
  await page.goto(`${BASE}/portal/promotion`);
  await page.click('a[href*="/portal/promotion?batch="]');
  await page.fill('input[name=reason]', 'Browser QA reversal with a long enough reason.');
  await page.click('text=Reverse promotion');
  await status(page, 'Promotion reversed', 'principal reverses the promotion');

  await overflow(page, 'desktop promotion');
  await page.close();

  // ── Mobile (390x844) ────────────────────────────────────────────────────
  const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(mobile, 'PRINCIPAL');
  for (const [path, name] of [
    ['/portal/promotion', 'mobile promotion office'],
    ['/portal/transcripts', 'mobile transcript office'],
    ['/verify/transcript', 'mobile public verify'],
  ] as const) {
    await mobile.goto(`${BASE}${path}`);
    await mobile.waitForLoadState('networkidle');
    await overflow(mobile, name);
  }
  await shot(mobile, 'promotion-mobile');
  await mobile.close();

  // ── Teacher gating ──────────────────────────────────────────────────────
  const teacher = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await signIn(teacher, 'STF001');
  await teacher.goto(`${BASE}/portal/promotion`, { waitUntil: 'domcontentloaded' });
  if (teacher.url().endsWith('/portal')) ok('teacher is redirected away from promotion');
  else fail('teacher gating', `landed on ${teacher.url()}`);
  await teacher.close();

  await browser.close();
  console.log(`\n${passes} passed, ${failures.length} failed.`);
  if (failures.length) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
