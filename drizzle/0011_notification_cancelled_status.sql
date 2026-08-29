-- ============================================================================
-- notification_status 'cancelled'.
--
-- A queued message whose subject stopped being true before it was sent: a
-- reminder for an appointment that was cancelled, or for a time that no longer
-- exists because the booking moved.
--
-- DELIBERATELY NOT 'failed'. Nothing went wrong — the product withdrew the
-- message on purpose — and an owner scanning the outbox for real delivery
-- problems should not have to sift these out of genuine ones. It is also what
-- lets the reschedule path be honest: the old reminder row is withdrawn and a
-- new one written, rather than the old row being edited into something it was
-- never queued as.
--
-- ADD VALUE is safe inside a transaction on Postgres 12+ as long as the new
-- label is not USED in the same transaction. Nothing below uses it.
-- ============================================================================

ALTER TYPE "public"."notification_status" ADD VALUE 'cancelled';
