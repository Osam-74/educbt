# Help Center (`/help`)

A self-service guide for everyone who uses EduCBT. It is public (signed-out visitors can read it, so someone who cannot sign in can still get help) and describes only screens that exist.

## How it is built

| Part | Where |
| --- | --- |
| Pages | `src/app/help/**` (home, category, article, search, FAQ), styles in `help.css` |
| Components | `src/components/help/**` (search with live suggestions, drawer navigation, block renderer) |
| Content | `src/lib/help/articles/*.ts` (typed data, no JSX), `faqs.ts` |
| Registry, search, roles | `src/lib/help/registry.ts`, `search.ts`, `roles.ts`, `viewer.ts` |
| Integrity test | `npm run test:help` (also in `baseline.yml`) |

The browser receives only a compact index (title, description, category, keywords). Article bodies are rendered on the server, so `/help` stays light.

## Adding or changing an article

1. Find the category file in `src/lib/help/articles/` and add one object (see `types.ts`). Use a new slug that is unique across all categories.
2. Write only what the app does. Quote on-screen labels in `**bold**`; refer to another guide by its exact title in `*italics*`.
3. List 3 or more `keywords` people would type, including the plain words (`exam`, `student`, `password`).
4. Add `related` slugs, and an `audience` (who it is written for).
5. Run `npm run test:help`. It fails on a duplicate slug, a dead related link, an italic title that matches no article, a missing screenshot file, or a FAQ pointing nowhere.

## Screenshots

`HelpBlock` supports `{ type: 'figure', figure: { src, alt, caption } }`. Put the real image in `public/help/` and reference it as `/help/<name>.png`. With no `src` the figure renders nothing, so there is never a placeholder or fake capture. No screenshots are included yet because none have been captured from a real school.

## Verification: what each category was checked against

This is the rule: **a guide may only say what the code does.** Each file's header comment lists the source files it was checked against.

| Category | Verified against |
| --- | --- |
| Account & Security | `src/app/sign-in`, `forgot-password`, `reset-password`, `portal/account/**`, `src/lib/auth/**` |
| Examinations | `portal/questions`, `exams/approvals`, `exams/[seriesId]`, `timetable`, `invigilation`, `invigilate`, `marking`, `src/lib/exam/**` |
| School Management | `portal/students`, `staff`, `classes`, `subjects`, `registration`, `settings`, `src/lib/people/**` |
| Results & Records | `portal/ca`, `results`, `reports`, `remarks`, `signature`, `promotion`, `transcripts`, `my-results`, `children` |
| Getting started, Troubleshooting | The set-up dependencies and error messages in the same code |

### Re-verify when these change

If a label, role guard, limit or message in the files above changes, update the matching guide in the same commit. The test catches broken references, not stale facts, so a human check is still needed.

## Who sees what

The guides describe how to use screens the reader must already be signed in and authorised to open; they expose no data. Role handling is therefore about **relevance, not secrecy**: a signed-in user's role sets the default "I am a..." filter on Home and the FAQ, with a "Show all" choice. A signed-out visitor sees everything, each guide labelled "For: ...". Real access control stays on the pages themselves.

## Support

The Help Center does not invent a support channel. Every page ends with "ask your school office", because the office can see the account, issue a temporary password and change a role. If a platform-level contact is added later, put it in `layout.tsx`.

## Not yet covered

Notifications, Announcements and Messages (how to send and read), the Activity log, Analysis (Subject Results), the account/profile page beyond recovery email, and Platform Admin are not yet documented. They are real features; add guides once their on-screen text has been checked.
