/**
 * Mobile QA for the platform-admin shell drawer (the reported hamburger bug).
 *
 * Signs in as PLATFORM-ADMIN by injecting a real session cookie (the local
 * http server sets `secure` cookies that Chromium won't replay — a known
 * local-only quirk), then at a 390x844 viewport:
 *
 *   1. the burger is visible and the desktop sidebar is hidden;
 *   2. clicking the burger opens the drawer AND its nav is actually visible
 *      (the bug: the drawer's sidebar copy was translated off-canvas, so
 *      the dialog rendered blank white and trapped the page);
 *   3. the close button closes the drawer and the page is interactive again;
 *   4. no horizontal overflow anywhere on the platform dashboard.
 *
 * Run: tsx tmp-qa/platform-mobile-qa.ts   (expects the dev server on :3010
 * and DATABASE_URL pointing at the local CA test database).
 */
import { chromium } from 'playwright-core';
import { createSession } from '@/lib/auth/session-store';

const BASE = process.env.QA_BASE ?? 'http://localhost:3010';
const SHOTS = '/app/conversations/6aa0f8fb35533b8915a1d696/tmp-qa/shots';

let passes = 0;
const failures: string[] = [];
const ok = (n: string) => { passes++; console.log(`PASS ${n}`); };
const fail = (n: string, why: string) => { failures.push(`${n}: ${why}`); console.log(`FAIL ${n}: ${why}`); };

async function main() {
  // ── A real session for the platform admin ────────────────────────────────
  const { token } = await createSession(8, null, 'qa-mobile');

  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await ctx.addCookies([{
    name: 'educbt.session',
    value: token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }]);

  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/platform`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('#pa-header', { timeout: 20000 });

  // 1. burger visible, desktop sidebar hidden at this width
  const burgerVisible = await page.isVisible('.pa-burger');
  burgerVisible ? ok('burger visible at 390px') : fail('burger visible at 390px', 'not visible');
  const sidebarHidden = await page.$eval('#pa-sidebar', (el) => getComputedStyle(el).display === 'none');
  sidebarHidden ? ok('desktop sidebar hidden at 390px') : fail('desktop sidebar hidden', 'still displayed');

  // 2. click the burger — drawer must open with VISIBLE nav (the reported bug)
  await page.click('.pa-burger');
  await page.waitForSelector('dialog.pa-drawer[open]', { timeout: 5000 });
  ok('drawer dialog opens');

  await page.waitForSelector('.pa-drawer .pa-nav-item', { timeout: 5000 }).catch(() => {});
  const drawerState = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLAnchorElement>('.pa-drawer .pa-nav-item'));
    const first = items[0];
    if (!first) return { count: 0, visible: false, label: '' };
    const r = first.getBoundingClientRect();
    const cs = getComputedStyle(first);
    const visible = r.width > 0 && r.height > 0 && parseFloat(cs.opacity || '1') > 0.01
      && cs.visibility !== 'hidden' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)';
    // translated off-canvas: rect.x far left of the dialog
    const dialog = first.closest('dialog')!.getBoundingClientRect();
    const inside = r.left >= dialog.left - 1 && r.right <= dialog.right + 1;
    return { count: items.length, visible: visible && inside, label: first.textContent?.trim() ?? '' };
  });
  drawerState.count >= 3
    ? ok(`drawer nav has ${drawerState.count} items`)
    : fail('drawer nav items', `only ${drawerState.count} found`);
  drawerState.visible
    ? ok(`drawer nav is VISIBLE on canvas (first item: "${drawerState.label}")`)
    : fail('drawer nav visible', 'items are off-canvas or invisible — the white-drawer bug');

  await page.screenshot({ path: `${SHOTS}/platform-mobile-drawer-open.png` });

  // close button must be reachable and work
  await page.click('.pa-drawer .pa-sidebar-close');
  await page.waitForFunction(() => !document.querySelector('dialog.pa-drawer')?.hasAttribute('open'), null, { timeout: 5000 });
  ok('close button closes the drawer');
  const bodyScrollRestored = await page.evaluate(() => document.body.style.overflow !== 'hidden');
  bodyScrollRestored ? ok('body scroll restored after close') : fail('body scroll restored', 'still locked');

  // 3. page still interactive after close (dialog really released the page)
  await page.click('.pa-burger');
  await page.waitForSelector('dialog.pa-drawer[open]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.pa-drawer')?.hasAttribute('open'), null, { timeout: 5000 });
  ok('Escape also closes the drawer');

  // 3b. stat grid: 2 columns, headline card spans two rows and is taller
  const stats = await page.evaluate(`(() => {
    const grid = document.querySelector('.pa-stat-grid');
    const cs = getComputedStyle(grid);
    const cards = Array.from(grid.children).map((c) => c.getBoundingClientRect());
    const a = cards[0], b = cards[1], c = cards[2];
    return {
      cols: cs.gridTemplateColumns.split(' ').length,
      firstSpansRows: (a.height > b.height * 1.4) && (a.height > c.height * 1.4),
      secondColBelow: (b.left - a.left) > 50 && (c.left - a.left) > 50,
    };
  })()`);
  stats.cols === 2 ? ok('stat grid is 2 columns at 390px') : fail('stat grid columns', `${stats.cols}`);
  stats.firstSpansRows ? ok('Total schools card spans both rows (tall)') : fail('stat grid first card', 'not visibly taller than siblings');
  stats.secondColBelow ? ok('Active + Suspended stack in the second column') : fail('stat grid second column', 'cards not offset right');
  await page.screenshot({ path: `${SHOTS}/platform-mobile-statgrid.png`, fullPage: true });

  // 4. no horizontal overflow on the platform dashboard at 390px
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  over > 1 ? fail('dashboard overflow @390px', `${over}px`) : ok('no horizontal overflow @390px');

  if (consoleErrors.length) fail('no page errors', consoleErrors.slice(0, 2).join(' | '));
  else ok('no page errors during the run');

  await page.screenshot({ path: `${SHOTS}/platform-mobile-dashboard.png`, fullPage: false });
  await browser.close();

  if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1); }
  console.log(`\nAll ${passes} mobile drawer checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
