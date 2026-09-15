/** Visual check: sidebar logo fills its tile + mobile 2-col stat grid. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@/db';
import { createSession } from '@/lib/auth/session-store';
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3010';
const SHOTS = '/app/conversations/6aa0f8fb35533b8915a1d696/tmp-qa/shots';

async function main() {
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const odb = drizzle(owner, { schema });
  const [admin] = await odb.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.loginId, 'PLATFORM-ADMIN'), isNull(schema.users.schoolId))).limit(1);
  const { token } = await createSession(Number(admin!.id), null, 'logo-qa');
  await owner.end();

  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
  const results: string[] = [];

  // Desktop
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dctx.addCookies([{ name: 'educbt.session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const dpage = await dctx.newPage();
  await dpage.goto(`${BASE}/platform`, { waitUntil: 'networkidle', timeout: 60000 });
  const mark = dpage.locator('.pa-sidebar-head .pa-brand-mark').first();
  await mark.waitFor({ timeout: 20000 });
  const fill = await dpage.evaluate(() => {
    const tile = document.querySelector('.pa-brand-mark') as HTMLElement;
    const img = tile.querySelector('img') as HTMLImageElement;
    const tr = tile.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    return { tile: [tr.width, tr.height], img: [ir.width, ir.height], natural: [img.naturalWidth, img.naturalHeight], covered: ir.width >= tr.width - 1 && ir.height >= tr.height - 1 };
  });
  results.push(`desktop logo: tile ${fill.tile.join('x')} img ${fill.img.join('x')} natural ${fill.natural.join('x')} fills=${fill.covered}`);
  await dpage.screenshot({ path: `${SHOTS}/logo-desktop.png` });

  // Mobile stats grid
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mctx.addCookies([{ name: 'educbt.session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/platform`, { waitUntil: 'networkidle', timeout: 60000 });
  await mpage.waitForSelector('.pa-stat-grid', { timeout: 20000 });
  const grid = await mpage.evaluate(() => {
    const cards = [...document.querySelectorAll('.pa-stat-grid > .pa-stat')].map(el => el.getBoundingClientRect());
    return { cols: getComputedStyle(document.querySelector('.pa-stat-grid')!).gridTemplateColumns, boxes: cards.map(b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]) };
  });
  results.push(`mobile grid cols: ${grid.cols}`);
  grid.boxes.forEach((b, i) => results.push(`card ${i + 1}: left=${b[0]} top=${b[1]} w=${b[2]} h=${b[3]}`));
  await mpage.screenshot({ path: `${SHOTS}/logo-mobile-stats.png`, fullPage: true });
  await mpage.evaluate(() => document.querySelector('.pa-burger')?.click());
  await mpage.waitForTimeout(400);
  await mpage.screenshot({ path: `${SHOTS}/logo-mobile-drawer.png` });

  await browser.close();
  console.log(results.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
