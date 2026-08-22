-- ============================================================================
-- A hold belongs to nobody yet.
--
-- Tapping a time writes a real `held` row immediately — that is the only way
-- the slot is genuinely reserved while the customer fills in the form, and the
-- exclusion constraint covers `held` precisely so it is. But at that moment
-- there is no customer: they have not typed their name, let alone their email,
-- and `customers` is deduped by (business_id, email), so a placeholder row
-- would have to invent one and would outlive the hold that created it.
--
-- So `customer_id` becomes nullable, and a CHECK keeps the hole exactly the
-- size of the fact: only a `held` appointment may be anonymous. Anything
-- confirmed, completed, cancelled or no-show has a customer, which is what
-- every query downstream already assumes.
--
-- Safe on a populated table: dropping NOT NULL rewrites nothing, and the CHECK
-- is satisfied by every existing row (they all have a customer).
-- ============================================================================

ALTER TABLE "appointments" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_required_once_booked"
  CHECK ("appointments"."status" = 'held' OR "appointments"."customer_id" IS NOT NULL);
