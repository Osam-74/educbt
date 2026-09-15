/**
 * Platform Admin sidebar route matching — pure, no React/DOM — so it can be
 * unit-tested with `tsx` alone (see nav.test.ts) and shared by the
 * server-rendered page name lookup and the client sidebar's active state.
 *
 * BUG THIS REPLACES: naive prefix matching (`pathname.startsWith(href)`)
 * makes BOTH "Schools" (/platform/schools) and "New school"
 * (/platform/schools/new) active at once, because the New-school path is
 * literally a sub-path of the Schools path. Each nav item below gets its
 * own exact rule instead of a shared prefix test, so a school's numeric
 * detail/edit route highlights "Schools" (it is part of that directory)
 * while "New school" only ever lights up for its own route.
 */

export const PLATFORM_NAV_HREFS = [
  '/platform',
  '/platform/schools',
  '/platform/schools/new',
  '/platform/branding',
  '/platform/managers',
  '/platform/account',
] as const;

export type PlatformNavHref = (typeof PLATFORM_NAV_HREFS)[number];

/** True if `pathname` should highlight the nav item for `href`. */
export function isNavItemActive(href: PlatformNavHref, pathname: string): boolean {
  switch (href) {
    case '/platform':
      // Exact only — every other /platform/... route has its own item.
      return pathname === '/platform';
    case '/platform/schools':
      // The directory itself, or a specific school's detail/edit page —
      // but NOT /platform/schools/new (that is its own nav item).
      return pathname === '/platform/schools' || /^\/platform\/schools\/\d+(\/edit)?$/.test(pathname);
    case '/platform/schools/new':
      return pathname === '/platform/schools/new';
    case '/platform/branding':
      return pathname === '/platform/branding';
    case '/platform/managers':
      return pathname === '/platform/managers';
    case '/platform/account':
      // Settings → Account owns the whole account tree: the consolidated
      // screen itself, plus the standalone flows it links into (forced
      // password change, TOTP enrolment).
      return pathname.startsWith('/platform/account');
    default:
      return pathname === href;
  }
}

/** Human page name shown in the header, from the same route table. */
export function pageNameFor(pathname: string): string {
  if (pathname === '/platform') return 'Dashboard';
  if (pathname === '/platform/schools') return 'Schools directory';
  if (pathname === '/platform/schools/new') return 'New school';
  if (pathname === '/platform/branding') return 'Branding';
  if (pathname === '/platform/managers') return 'Managers';
  if (/^\/platform\/schools\/\d+\/edit$/.test(pathname)) return 'Edit school';
  if (/^\/platform\/schools\/\d+$/.test(pathname)) return 'School details';
  if (pathname.startsWith('/platform/account')) return 'Account';
  return 'Platform';
}
