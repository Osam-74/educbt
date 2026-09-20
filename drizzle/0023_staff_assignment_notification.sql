-- New notification type for "you have been assigned to teach/head a
-- class or subject" — sent from assignBulk() in src/lib/people/staff.ts.
ALTER TYPE "public"."notification_type" ADD VALUE 'staff_assigned';
