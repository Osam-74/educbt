# EduCBT migration reference

Before implementing or refining any user-facing feature, inspect its corresponding implementation and assets in https://github.com/Osam-74/cbt.git. Record the reference commit and relevant files in feature parity notes. If the source is unavailable, obtain it before implementation; do not guess.

Treat the legacy plugin as the functional and visual reference: preserve useful workflows, fields, terminology, layouts, branding, report-card design, school logo and watermark usage, signatures, print structure, role behavior and other relevant UX details. Port intent rather than PHP or WordPress mechanisms.

Keep Next.js architecture, server-side authorization, tenant isolation, RLS, services and tested domain rules intact. Document unsupported legacy behavior and storage gaps before choosing a replacement. Explain intentional differences, including any legacy behavior that conflicts with the new security or domain rules. Passing print tests alone does not establish visual parity.
