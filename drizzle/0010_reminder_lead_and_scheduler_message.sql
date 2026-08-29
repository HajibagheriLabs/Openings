-- ============================================================================
-- What scheduled delivery needs on the two rows it touches.
--
-- 1. businesses.reminder_lead_min.
--    How long before an appointment the reminder goes out. A SETTING rather
--    than a constant, because the right answer genuinely differs by trade: a
--    dentist wants a day so the chair can be refilled, a walk-in barber wants
--    two hours so the reminder is still actionable. Default 1440 — the day
--    before — which is what every existing row gets, so nothing changes for a
--    business that never opens the setting.
--
-- 2. notifications.scheduler_message_id.
--    The delivery service's handle on the message that will fire this row.
--    Reminders are scheduled PER BOOKING, for a time that may be weeks out, so
--    when the appointment moves or is cancelled that pending message has to be
--    called off — and the id is the only way to name it. Without this column a
--    rescheduled appointment would still fire its original reminder.
--
--    NULL is ordinary, not a failure. It means the daily catch-up owns the
--    row: no delivery service configured, a row already overdue when it was
--    written, or a confirmation, which is due immediately and never worth a
--    round trip to schedule.
--
-- Both statements add a column: the first with a constant default, which
-- Postgres 11+ stores in the catalogue rather than rewriting the table. No
-- long lock, safe on a populated table.
-- ============================================================================

ALTER TABLE "businesses" ADD COLUMN "reminder_lead_min" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "scheduler_message_id" text;
