-- ============================================================================
-- The concurrency boundary.
--
-- This one constraint is what makes the product correct. It replaces every
-- "check then insert" the application might be tempted to write, and it works
-- at READ COMMITTED with no locking code, no advisory locks, and no retry loop.
--
-- Why the application CANNOT do this itself:
--   SELECT ... WHERE slot && $new  -- sees nothing
--   INSERT ...                     -- another transaction did the same thing
-- Below SERIALIZABLE those two statements are not atomic with respect to a
-- concurrent transaction. Both sessions read an empty result, both insert, and
-- the business is double-booked. Postgres does not offer a way to lock a row
-- that does not exist yet. The constraint does, because it is enforced by an
-- index at write time rather than by anything either session observed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why btree_gist is required
--
-- The rule spans two columns of different natures: staff_id must match by
-- EQUALITY, slot must match by OVERLAP. GiST natively understands range
-- overlap (&&) but has no operator class for scalar equality on a uuid, so
-- "staff_id WITH =" alone would fail with:
--
--     data type uuid has no default operator class for access method "gist"
--
-- btree_gist (enabled in migration 0000) supplies that operator class, letting
-- one GiST index hold both columns. The result is a per-staff overlap test:
-- two appointments may overlap freely as long as they belong to different
-- staff members.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Why the predicate is a partial WHERE
--
-- Only 'held' and 'confirmed' occupy a slot. 'cancelled', 'completed' and
-- 'no_show' are history: they must stay in the table for the record, but they
-- must stop blocking the time they used to occupy, or a cancelled appointment
-- would poison its slot forever and nobody could rebook it.
--
-- A partial constraint says exactly that, and gets a smaller index for free:
-- rows that are not blocking are not in the index at all.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Why the predicate CANNOT be `hold_expires_at > now()`   <-- READ THIS
--
-- The obvious next thought is to make expired holds stop blocking by writing:
--
--     WHERE (status = 'confirmed'
--            OR (status = 'held' AND hold_expires_at > now()))
--
-- That is ILLEGAL, and Postgres rejects it:
--
--     ERROR:  functions in index predicate must be marked IMMUTABLE
--
-- The predicate of a partial index — and an exclusion constraint is backed by
-- one — decides which rows are physically stored in the index. It is evaluated
-- when a row is written, not when it is read. If it could reference now(), a
-- row would silently need to leave the index as time passed, and nothing
-- exists to rewrite the index at that moment. So the planner requires the
-- predicate to be IMMUTABLE, and now() is STABLE. There is no way around this
-- and no flag that relaxes it.
--
-- The consequence is the single most important thing to understand about this
-- schema: AN EXPIRED HOLD STILL BLOCKS ITS SLOT until some statement actually
-- DELETES the row. The database will not forget it on a timer.
--
-- Expiry is therefore enforced LAZILY, in two places, and both are mandatory:
--
--   1. Every availability query treats a hold with hold_expires_at < now() as
--      not blocking, so an expired hold is never shown as unavailable.
--
--   2. Every booking transaction FIRST deletes expired holds that would
--      collide, in the same transaction, before inserting:
--
--        DELETE FROM appointments
--         WHERE status = 'held'
--           AND hold_expires_at < now()
--           AND staff_id = $1
--           AND slot && $2;
--
--      and only then inserts, letting this constraint arbitrate the result.
--
-- The nightly janitor (reclaimExpiredHolds) only reclaims dead rows to keep
-- the table small. Correctness never depends on it running — if it never ran
-- again, the delete-then-insert above would still produce the right answer.
--
-- See src/lib/scheduling/booking.ts, which is the only place that writes here.
-- ----------------------------------------------------------------------------

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "staff_id" WITH =,
    "slot" WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed'));
