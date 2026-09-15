-- Platform branding (correction-pass items 6–7).
--
-- A singleton table holding the platform's OWN identity: the logo shown in
-- the admin shell header. Modeled on schools.logo_url — a DB-backed base64
-- PNG, re-encoded by normalizeImage(), so rendering never depends on
-- expiring object-storage URLs.
--
-- Singleton by construction: the service upserts exactly the row with
-- id = 1, and a CHECK makes any other id impossible. No school_id — this is
-- the platform's data, not a tenant's. RLS lives in src/db/rls.sql.
CREATE TABLE "platform_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "logo_url" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "platform_settings_singleton_ck" CHECK ("id" = 1)
);
