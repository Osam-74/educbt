/** Small line icons for category/article cards. Decorative, so hidden from screen readers. */
const PATHS: Record<string, string> = {
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  school: 'M3 10l9-6 9 6M5 10v9h14v-9M9 19v-5h6v5',
  exam: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  results: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  wrench: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2z',
  faq: 'M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2M12 18h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  key: 'M14 10a4 4 0 1 0-3 3.9L13 16h2v2h2v2h3v-3l-6-6.1',
};

export function HelpIcon({ name }: { name: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="hc-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name] ?? PATHS.faq} />
    </svg>
  );
}
