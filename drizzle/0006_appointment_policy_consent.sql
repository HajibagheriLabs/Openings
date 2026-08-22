-- ============================================================================
-- appointments.policy_accepted_at
--
-- The cancellation policy is printed on the details step in plain words —
-- never behind a link — and the customer ticks a box to say they have read it.
-- This is when they ticked it.
--
-- Nullable, and three different kinds of NULL are legitimate:
--   * a hold, which exists before the form is ever opened;
--   * a booking the owner typed in themselves, where the conversation about
--     the policy happened at the counter;
--   * anything created before this column existed.
-- So no CHECK ties it to a status. What it buys is the fourth case: a customer
-- who booked themselves and later says nobody told them about the window.
--
-- Safe on a populated table: a nullable column with no default rewrites
-- nothing and takes no long lock.
-- ============================================================================

ALTER TABLE "appointments" ADD COLUMN "policy_accepted_at" timestamp with time zone;
