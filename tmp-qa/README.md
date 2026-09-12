# QA harness (local, throwaway)

- `browser.ts` — Playwright end-to-end run against `demo.localhost:<port>`.
  Signs in as principal/teacher/parent and walks staff & student management,
  guardian redemption, and desktop/mobile (390px) overflow checks.
  Run from any folder with `tsx` + playwright installed; expects the seeded
  CA test database and the passwords reset via `set-qa-passwords.ts`.
- `set-qa-passwords.ts` — resets PRINCIPAL / STF001 / 2026010001 to the shared
  QA password before a browser run.
- `dbcheck.ts` — quick DB sanity probe.

These are developer conveniences, not part of the app build.
