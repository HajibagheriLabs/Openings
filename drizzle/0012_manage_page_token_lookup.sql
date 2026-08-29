-- ============================================================================
-- What the guest self-service page needs.
--
-- 1. notification_kind 'owner_reschedule' / 'owner_cancellation'.
--    A customer moving or cancelling their own appointment changes the diary
--    without anybody at the business touching it. Those are the two messages
--    that say so. Separate kinds rather than one: they are different sentences
--    about different events, and keeping them apart makes the outbox readable.
--
-- 2. rate_limits.
--    A fixed-window counter, in Postgres rather than in memory. /manage/<token>
--    is a public URL whose only credential is the secret in the path, so the
--    thing worth limiting is somebody guessing at it — and a per-process
--    counter on a serverless runtime counts a fresh attacker on every cold
--    start. One row per subject, overwritten when the window rolls, so the
--    table is bounded by active subjects rather than by traffic. The daily
--    sweep deletes what has gone quiet.
--
-- 3. businesses.refund_deposit_on_cancel.
--    Whether an in-time cancellation puts the deposit back. TRUE for every
--    existing row, because a customer who gave the notice the business asked
--    for has done what was asked of them. A business may turn it off — a
--    deposit that is really a booking fee is a legitimate model — and the
--    customer is then told in words, before they press the button.
--
-- 4. appointments_manage_token_hash_unique.
--    The manage page's ONLY lookup key: the route hashes the token from the
--    path and finds the row by that hash, so this turns a sequential scan into
--    an index seek. UNIQUE because the token is derived from `ics_uid`, which
--    is already unique — so two appointments sharing a manage token stops being
--    a silent disaster and becomes a write that fails.
--
-- The unique constraint builds an index on a populated table. On a table this
-- size that is instantaneous; on a large one it would want CONCURRENTLY, which
-- cannot run inside a transaction and so cannot live in this file.
-- ============================================================================

ALTER TYPE "public"."notification_kind" ADD VALUE 'owner_reschedule';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'owner_cancellation';--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "refund_deposit_on_cancel" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_manage_token_hash_unique" UNIQUE("manage_token_hash");
