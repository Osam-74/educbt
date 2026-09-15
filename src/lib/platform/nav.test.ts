/**
 * Route-state coverage for the Platform Admin sidebar — NO DATABASE.
 *
 *   npx tsx src/lib/platform/nav.test.ts   (wired as `npm run test:platform-nav`)
 *
 * Guards the exact bug the correction pass reported: New School and Schools
 * both lighting up together.
 */
import { isNavItemActive, pageNameFor } from './nav';

let failures = 0;
const check = (n: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (!ok) failures++;
};

const activeSet = (pathname: string) => ({
  dashboard: isNavItemActive('/platform', pathname),
  schools: isNavItemActive('/platform/schools', pathname),
  newSchool: isNavItemActive('/platform/schools/new', pathname),
  account: isNavItemActive('/platform/account', pathname),
  branding: isNavItemActive('/platform/branding', pathname),
  managers: isNavItemActive('/platform/managers', pathname),
});

// ── The reported bug, precisely ──────────────────────────────────────────────
{
  const a = activeSet('/platform/schools/new');
  check('New School active, Schools NOT active, on /platform/schools/new', a.newSchool && !a.schools);
  check('Dashboard not active on /platform/schools/new', !a.dashboard);
  check('Account not active on /platform/schools/new', !a.account);
}

// ── Every other route lights up exactly one item ────────────────────────────
{
  const a = activeSet('/platform');
  check('Dashboard active, and only Dashboard, on /platform', a.dashboard && !a.schools && !a.newSchool && !a.account);
}
{
  const a = activeSet('/platform/schools');
  check('Schools active, and only Schools, on /platform/schools', a.schools && !a.dashboard && !a.newSchool && !a.account);
}
{
  const a = activeSet('/platform/schools/42');
  check('Schools active (not New School) on a school detail route /platform/schools/42', a.schools && !a.newSchool);
}
{
  const a = activeSet('/platform/schools/42/edit');
  check('Schools active on the edit-school route /platform/schools/42/edit', a.schools && !a.newSchool);
}
{
  const a = activeSet('/platform/account');
  check('Account active, and only Account, on /platform/account', a.account && !a.dashboard && !a.schools && !a.newSchool && !a.branding);
}
{
  const a = activeSet('/platform/branding');
  check('Branding active, and only Branding, on /platform/branding', a.branding && !a.dashboard && !a.schools && !a.newSchool && !a.account);
}
{
  const a = activeSet('/platform/managers');
  check('Managers active, and only Managers, on /platform/managers', a.managers && !a.dashboard && !a.schools && !a.newSchool && !a.branding && !a.account);
}
{
  const a = activeSet('/platform/account/password');
  check('Account active on the forced password-change page /platform/account/password', a.account);
}
{
  const a = activeSet('/platform/account/security');
  check('Account active on the security/TOTP page /platform/account/security', a.account);
}
{
  const a = activeSet('/platform/account/profile');
  check('Account active on the forwarding profile route /platform/account/profile', a.account);
}
{
  const a = activeSet('/platform/schools/42');
  check('Account not active on school routes', !a.account);
}

// ── Page name lookup follows the same table ─────────────────────────────────
check('pageNameFor: dashboard', pageNameFor('/platform') === 'Dashboard');
check('pageNameFor: schools directory', pageNameFor('/platform/schools') === 'Schools directory');
check('pageNameFor: new school', pageNameFor('/platform/schools/new') === 'New school');
check('pageNameFor: branding', pageNameFor('/platform/branding') === 'Branding');
check('pageNameFor: managers', pageNameFor('/platform/managers') === 'Managers');
check('pageNameFor: school detail', pageNameFor('/platform/schools/7') === 'School details');
check('pageNameFor: edit school', pageNameFor('/platform/schools/7/edit') === 'Edit school');
check('pageNameFor: forced password-change page', pageNameFor('/platform/account/password') === 'Account');
check('pageNameFor: security page', pageNameFor('/platform/account/security') === 'Account');

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nAll platform nav route-state checks passed.');
