# Per-school document templates (platform administrators only)

A platform administrator chooses the print design of three documents for each school: the **terminal report card**, the **academic transcript** and the **broadsheet**. A school prints with whatever was assigned and has no setting for it. This page is for platform administrators; it is deliberately not part of the school Help Center, because school staff never see the feature.

## The six designs

| Key | Look |
|---|---|
| `classic` | The original EduCBT sheet. No stylesheet block of its own: it is `print.css` untouched. This is the default. |
| `heritage` | Navy and gold, double-ruled letterhead, small-caps labels. Traditional. |
| `metro` | Modern sans-serif, left-aligned letterhead, teal bar, zebra rows. |
| `ledger` | Black-and-white hairline rules, no fills. Best for photocopying. |
| `royal` | Burgundy page frame and banner title. Certificate feel. |
| `bright` | Rounded, colourful, friendly type. For nursery and primary. |

The list lives in `src/lib/templates/registry.ts`; the styling in `src/app/templates.css`. Adding a design is one registry entry plus one `.tpl-<key>` block. No migration is needed, because the database stores only the key.

## Who can change it

Only a platform administrator. Principals, teachers, parents and students cannot, and the school's own screens show neither a picker nor the name of the design.

This is enforced in three independent places, each tested on its own:

1. The page and action require a platform session.
2. `src/lib/templates/service.ts` re-checks the actor on every write and refuses any other role.
3. The database refuses the write: `school_document_templates` is readable by the school (the print pages resolve their design inside the school's own session) but writable only by an elevated platform administrator (`src/db/rls.sql`).

The assignment sits in its own table, not on `schools`, because the `schools` policy lets a school write its own row, which would let a principal re-skin their own documents.

## Where it is set

- **Registering a school** (`/platform/schools/new`): a Document templates section with three groups, Classic preselected for each. The choice is stored in the same transaction as the school, so an unknown key creates nothing (no school, no principal).
- **One school** (`/platform/schools/<id>/templates`, linked from the school page and its edit page): each document can be set, or set to "Inherit the platform default". A line shows what the school is printing now.
- **Platform defaults** (`/platform/templates`, in the platform menu): used by every school without its own choice.
- **Preview** (`/platform/templates/preview?kind=<report|transcript|broadsheet>&template=<key>`): a sample in that design, using invented names and marks only. It reads no school data, needs a platform session, and returns 404 for an unknown document type or design.

## How a school's design is resolved

For each document: the school's own value, else the platform default, else `classic`. A stored key that no longer exists falls through to the next step instead of breaking printing. A school with no row at all, or a null value, prints exactly as it did before this feature.

The chosen design is applied as a `tpl-<key>` class on the root `.doc` element of the report card, the whole-class print, the transcript and the broadsheet. Classic adds no class.

## Restoring and backups

`school_document_templates` is **excluded** from school backups. A restored school gets no row and prints with the platform default. This is intentional: a backup file must not be able to carry a design the platform administrator did not assign.

## Audit

Every change writes an audit row with the values before and after: `school.templates_changed` for one school, `platform.default_templates_changed` for the defaults, and the choices made at registration are recorded inside `school.created`.

## Database

Migration `0039_document_templates.sql` is additive: it creates `school_document_templates` and adds three `default_*_template` columns (default `classic`) to `platform_settings`. Nothing is removed or rewritten.

`rls.sql` also gives the `platform_settings` write policy a `USING` clause. Without it an UPDATE (and the update half of an upsert) matched no existing row, so the platform defaults could not be saved. Only an elevated platform administrator can write, as before.

## Tests

- `npm run test:templates` (34 checks, local database only): who may write (service and database policy), tenant reads, resolution order, key validation, creation with and without designs, audit rows. Planted bugs were caught: no actor check on each of the two write paths, an unknown key accepted, the school created before the keys are checked, and a database policy that lets any tenant write.
- `npm run test:templates-print` (24 cases, six designs by four document shapes): print layout under WeasyPrint. The long-names report case prints two pages for every design, as classic always has.
- `npm run test:platform-nav`: the menu item and the highlighting of the per-school page under Schools.

## Known, not part of this feature

`npm run test:school-backup-registry` already fails on `main` for six calendar and timetable tables (`academic_calendars`, `calendar_events`, `calendar_event_classes`, `timetable_periods`, `timetable_lessons`, `timetable_publication`). It is not in CI and is not caused by templates.

Migration 0039 has **not** been applied to production. Apply it, then re-run the row-level security script, before this branch is deployed.
