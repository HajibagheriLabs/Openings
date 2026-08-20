-- ============================================================================
-- accounts.issuer
--
-- Better Auth 1.7 identifies a credential by the PAIR (issuer, account_id)
-- rather than by (provider_id, account_id). `issuer` is the namespace the
-- identity belongs to: a real OpenID issuer URL for a social provider, or a
-- synthetic `local:<provider_id>` for a provider that has none — which is
-- every provider this product enables, since email and password is the only
-- one and customers never authenticate at all.
--
-- Added in three steps rather than one so it is safe against a database that
-- already has rows. `ADD COLUMN ... NOT NULL` with no default fails outright
-- on a populated table, and anyone who signed up before this migration would
-- have to drop their database to apply it.
-- ============================================================================

ALTER TABLE "accounts" ADD COLUMN "issuer" text;--> statement-breakpoint

-- Backfill. `local:` || provider_id reproduces what Better Auth generates for
-- a provider with no issuer of its own. It is a plain concatenation because
-- the library URL-encodes the provider id, and the only id in this database is
-- "credential", which encodes to itself.
UPDATE "accounts" SET "issuer" = 'local:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint

-- The recognition key. Two rows may share an issuer, and two issuers may
-- describe the same account id, but the pair is one identity.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_issuer_account_id_unique" UNIQUE("issuer","account_id");--> statement-breakpoint

-- Every session lookup walks from a user to their accounts.
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");
