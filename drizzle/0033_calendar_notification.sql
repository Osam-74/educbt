-- The academic calendar sends reminders and publication notices. ADDITIVE ONLY: one new value on the existing notification type.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'calendar_event';
