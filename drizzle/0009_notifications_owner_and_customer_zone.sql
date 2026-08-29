-- ============================================================================
-- Two additions the notification worker needs.
--
-- 1. notification_kind 'new_booking'.
--    The OWNER's copy. `confirmation` goes to the customer and says "you are
--    booked in"; this one goes to the business and says "somebody booked", with
--    the customer's name, phone and note on it. They are different messages to
--    different people about the same appointment, and squeezing both out of one
--    row would mean one of the two audiences reading the other's email.
--
--    ADD VALUE is safe inside a transaction on Postgres 12+ as long as the new
--    label is not USED in the same transaction. Nothing below uses it.
--
-- 2. customers.timezone.
--    The customer's own IANA zone, as their browser reported it at booking.
--    NULLABLE, and never scheduled in: every instant in this database is UTC and
--    every expansion happens in the BUSINESS's zone. This column decides one
--    thing only — whether a confirmation says "14:00 (Europe/Berlin)" or
--    "14:00 (Europe/Berlin), which is 13:00 where you are". A booking entered by
--    hand at the counter has no browser to ask, so the column has to be allowed
--    to be absent rather than defaulted to a guess.
--
-- Both statements add a nullable column or an enum label: no rewrite, no long
-- lock, safe on a populated table.
-- ============================================================================

ALTER TYPE "public"."notification_kind" ADD VALUE 'new_booking';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "timezone" text;
