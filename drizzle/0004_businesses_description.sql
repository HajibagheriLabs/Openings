-- ============================================================================
-- businesses.description
--
-- One line under the business name on the public booking page. Nullable on
-- purpose: a business that has not written one shows no line at all, rather
-- than a placeholder pretending to be copy.
--
-- Safe against a populated table — a nullable column with no default rewrites
-- nothing and takes no long lock.
-- ============================================================================

ALTER TABLE "businesses" ADD COLUMN "description" text;
