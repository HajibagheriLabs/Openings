-- ============================================================================
-- THE DEMO WORKSPACE
--
-- One column and two triggers. The column marks a business as scenery; the
-- triggers stop a passer-by dismantling it.
--
-- WHY A TRIGGER AND NOT ONLY AN APPLICATION CHECK
--
-- The Server Actions refuse these things too, and they refuse them with a
-- sentence a person can read — that is what the application layer is for. But
-- the demo is a URL anybody on the internet can click, and "no future action
-- may forget this" is not a property a codebase can promise about itself. It is
-- the same argument as the no-overlap exclusion constraint: the database is the
-- arbiter, and the application check exists to produce a better error message
-- than the arbiter's.
--
-- WHAT IS PROTECTED, AND WHAT DELIBERATELY IS NOT
--
--   Refused: changing a demo business's timezone, slug or currency, and
--   deleting a demo business, its services, its staff or its customers. Those
--   are the rows the whole demonstration is made of: a visitor who deleted the
--   stylists would leave the next visitor an empty grid, and re-zoning the
--   business would silently move every appointment on the calendar.
--
--   Allowed: everything else, and that is the point of a demo. Blocking time
--   and undoing it deletes a `time_off` row. Editing hours deletes and rewrites
--   `availability_rules`. Expired holds are swept from `appointments` by the
--   janitor. Booking, cancelling, marking a no-show and writing a note all
--   still work exactly as they do for a real business, because a demo you
--   cannot change is a screenshot.
--
-- THE BYPASS
--
-- `openings.demo_bypass` is a session setting. Two callers set it, both of them
-- ours and both of them documented: the seed script, which has to tear the
-- previous demo down before it can build the next one, and the nightly tidy-up,
-- which removes bookings visitors left behind. `current_setting(..., true)`
-- returns NULL rather than raising when the setting was never set, which is the
-- ordinary case for every other connection.
-- ============================================================================

ALTER TABLE "businesses"
  ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- True only inside a transaction that has deliberately asked for it.
CREATE OR REPLACE FUNCTION openings_demo_bypass() RETURNS boolean AS $$
  SELECT coalesce(current_setting('openings.demo_bypass', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 1. The demo's own settings are fixed.
--
-- The timezone above all: two businesses in two zones is the thing this demo
-- exists to show, and it is also the setting that would silently rewrite the
-- meaning of every appointment already on the calendar.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION openings_guard_demo_business() RETURNS trigger AS $$
BEGIN
  IF openings_demo_bypass() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN
      RAISE EXCEPTION 'The demo business cannot be deleted.'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD.is_demo AND (
       NEW.timezone IS DISTINCT FROM OLD.timezone
    OR NEW.slug     IS DISTINCT FROM OLD.slug
    OR NEW.currency IS DISTINCT FROM OLD.currency
  ) THEN
    RAISE EXCEPTION 'The demo business timezone, slug and currency are fixed.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER businesses_guard_demo
  BEFORE UPDATE OR DELETE ON "businesses"
  FOR EACH ROW EXECUTE FUNCTION openings_guard_demo_business();
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 2. The demo's cast cannot be deleted.
--
-- `business_id` is on every one of these tables, so the trigger is one lookup
-- and the same function serves all four.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION openings_guard_demo_child() RETURNS trigger AS $$
BEGIN
  IF openings_demo_bypass() THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM businesses
     WHERE businesses.id = OLD.business_id
       AND businesses.is_demo
  ) THEN
    RAISE EXCEPTION 'Records in the demo workspace cannot be deleted.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER services_guard_demo
  BEFORE DELETE ON "services"
  FOR EACH ROW EXECUTE FUNCTION openings_guard_demo_child();
--> statement-breakpoint

CREATE TRIGGER staff_guard_demo
  BEFORE DELETE ON "staff"
  FOR EACH ROW EXECUTE FUNCTION openings_guard_demo_child();
--> statement-breakpoint

CREATE TRIGGER customers_guard_demo
  BEFORE DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION openings_guard_demo_child();
