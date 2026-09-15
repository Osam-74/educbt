/**
 * Platform Admin iconography.
 *
 * The reference design uses Lucide, which isn't a dependency of this
 * project (the school portal's PortalIcon uses inline SVG instead — see
 * src/app/portal/PortalShell.tsx). Rather than add a new icon library for
 * one section, this follows the SAME existing pattern: a small inline-SVG
 * icon set, keyed by name, in the same visual language (24x24, stroke-based,
 * rounded caps) as the rest of the app.
 */
import type { SVGProps } from 'react';

const PATHS: Record<string, string> = {
  dashboard: 'M3 13h8V3H3z M13 21h8V9h-8z M3 21h8v-4H3z M13 7h8V3h-8z',
  schools: 'M2 8l10-5 10 5-10 5z M6 11v6q6 5 12 0v-6 M12 22v-4',
  plus: 'M12 5v14 M5 12h14',
  key: 'M15.5 9.5a4.5 4.5 0 1 1-4.9 4.9L3 22l-2-2 2-2-1-1 2-2-1-1 2-2 3.6-3.6a4.5 4.5 0 0 1 7.9-1.9z M17 7l1.5 1.5',
  shield: 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z M9 12l2 2 4-4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M18 6L6 18',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  building: 'M4 21V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v17 M16 21V10a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v11 M4 21h16 M8 7h1 M8 11h1 M8 15h1',
  mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
  copy: 'M9 9h11v11H9z M5 15V4a1 1 0 0 1 1-1h11',
  check: 'M20 6L9 17l-5-5',
  checkCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M8 12l3 3 5-6',
  external: 'M14 4h6v6 M20 4L10 14 M6 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2c2.6 2.7 4 6.2 4 10s-1.4 7.3-4 10c-2.6-2.7-4-6.2-4-10s1.4-7.3 4-10z',
  calendar: 'M4 5h16v16H4z M4 9h16 M8 3v4 M16 3v4',
  userCheck: 'M8 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 6-6h1a6 6 0 0 1 4.5 2 M16 14l2 2 4-4',
  phone: 'M6 3h4l1 5-3 2a13 13 0 0 0 6 6l2-3 5 1v4a2 2 0 0 1-2 2A17 17 0 0 1 4 5a2 2 0 0 1 2-2z',
  mapPin: 'M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  alert: 'M12 2 22 20H2z M12 9v5 M12 17h.01',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 8h.01 M11 12h1v5h1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 10.6a3 3 0 0 0 4.2 4.2 M9.9 4.2A10.4 10.4 0 0 1 12 4c6 0 10 7 10 7a15.6 15.6 0 0 1-3 3.8 M6.1 6.1A15.9 15.9 0 0 0 2 11s4 7 10 7a9.9 9.9 0 0 0 3.9-.8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  filter: 'M4 4h16l-6 8v6l-4 2v-8z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
  spark: 'M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 1 1 8 0v4',
  edit: 'M14 5l5 5 M4 20l4-1L21 6l-4-4L4 15z',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
};

export function PaIcon({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
