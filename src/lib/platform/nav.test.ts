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
  password: isNavItemActive('/platform/account/password', pathname),
});

// ── The reported bug, precisely ──────────────────────────────────────────────
{
  const a = activeSet('/platform/schools/new');
  check('New School active, Schools NOT active, on /platform/schools/new', a.newSchool && !a.schools);
  check('Dashboard not active on /platform/schools/new', !a.dashboard);
  check('Password not active on /platform/schools/new', !a.password);
}

// ── Every other route lights up exactly one item ────────────────────────────
{
  const a = activeSet('/platform');
  check('Dashboard active, and only Dashboard, on /platform', a.dashboard && !a.schools && !a.newSchool && !a.password);
}
{
  const a = activeSet('/platform/schools');
  check('Schools active, and only Schools, on /platform/schools', a.schools && !a.dashboard && !a.newSchool && !a.password);
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
  const a = activeSet('/platform/account/password');
  check('Password active, and only Password, on /platform/account/password', a.password && !a.dashboard && !a.schools && !a.newSchool);
}
{
  const a = activeSet('/platform/account/security');
  check('Password active on the security/TOTP page /platform/account/security', a.password);
}
{
  const a = activeSet('/platform/account/profile');
  check('No nav item falsely claims /platform/account/profile', !a.dashboard && !a.schools && !a.newSchool && !a.password);
}

// ── Page name lookup follows the same table ─────────────────────────────────
check('pageNameFor: dashboard', pageNameFor('/platform') === 'Dashboard');
check('pageNameFor: schools directory', pageNameFor('/platform/schools') === 'Schools directory');
check('pageNameFor: new school', pageNameFor('/platform/schools/new') === 'New school');
check('pageNameFor: school detail', pageNameFor('/platform/schools/7') === 'School details');
check('pageNameFor: edit school', pageNameFor('/platform/schools/7/edit') === 'Edit school');
check('pageNameFor: password', pageNameFor('/platform/account/password') === 'Password');
check('pageNameFor: security', pageNameFor('/platform/account/security') === 'Security');

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nAll platform nav route-state checks passed.');
