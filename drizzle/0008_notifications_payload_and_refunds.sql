-- ============================================================================
-- The webhook's three new needs.
--
-- 1. TWO NOTIFICATION KINDS.
--    `slot_lost` is the apology: a deposit was taken for a time that had
--    already gone, because the payment landed after the hold lapsed and
--    somebody else had booked it. `refund` is the only kind addressed to the
--    OWNER rather than to a customer — money went back, and they should hear
--    it from the product rather than from their Stripe dashboard.
--
--    ADD VALUE is safe inside a transaction on Postgres 12+ as long as the new
--    label is not USED in the same transaction. Nothing below uses it.
--
-- 2. appointments.refunded_at / refunded_cents.
--    Set by `charge.refunded`, and set directly by the slot-lost path when this
--    application initiates the refund itself. `refunded_at` already being
--    present is also how the webhook recognises its OWN refund and does not
--    alarm the owner about it a second time.
--
-- 3. notifications.payload.
--    The facts a message needs that the appointment does not carry: the
--    alternatives in an apology, the amount on a refund. Never a rendered
--    message — templates live in code, so a wording fix reaches rows already
--    queued. Never a secret.
--
-- All five statements add nullable columns or enum labels: no rewrite, no long
-- lock, safe on a populated table.
-- ============================================================================

ALTER TYPE "public"."notification_kind" ADD VALUE 'slot_lost';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'refund';--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "refunded_cents" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb;
