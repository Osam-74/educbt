# Portal shell parity

Reference: legacy Osam-74/cbt commit 0864e950a161f1bc2ffdb1744a35694fcebf3c90 and the supplied Principal dashboard screenshot (primary visual hierarchy).
Inspected templates/portal/shell.php, templates/portal/school/index.php, includes/Frontend/PortalRouter.php (areas, sections, areas_for_user), includes/Core/Capabilities.php and assets/css/educbt-portal.css.

Before implementation, identified gaps: no usable academic-calendar setup, school-settings, notifications, promotion, transcripts, signature/remarks management, activity archive, parent children landing, student published-results listing or teaching-registration routes. Do not create inert links or fake notifications. Report-card design belongs to another task. No CA rules are changed.

Retain forest sidebar, Areas, grouped links, active green stripe, school identity, role/session context, profile footer, four statistics, results pipeline and recent activity. Use reusable Next components and existing session/RLS guards. Navigation never grants permissions. Current Next school-wide staff/results access is preserved even where legacy capability naming differs. Personal teaching area appears for teachers and school managers with active assignments. Exam officers retain Teaching as in legacy. Family navigation contains only supported personal routes.

Current calendar must be unambiguous (one current session and one current term in it); do not guess a term from latest IDs. Pipeline groups stored subject results by active session enrollment and stage, counts distinct students per stage, and explicitly labels mixed stages; it is not a new class-result lifecycle. Recent activity shows safe event titles, never raw audit payloads, IPs, credentials or correction reasons; principal/deputy only, matching legacy activity-log capability. Sora-style spacing/weight uses the existing system font fallback to avoid a remote font dependency.
