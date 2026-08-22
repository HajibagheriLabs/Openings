"use client";

import { useEffect, useState } from "react";

import { HOLD_WARNING_SECONDS, type HoldSnapshot } from "@/lib/booking/hold";

/**
 * The countdown on a real hold.
 *
 * IT NEVER READS THE DEVICE'S WALL CLOCK. Every snapshot carries the server's
 * `expiresAt` AND the server's `serverNow`, so how much time is left at the
 * moment the answer arrived is a subtraction between two instants from ONE
 * clock. After that the only thing measured locally is ELAPSED time since that
 * answer — a duration, which every clock agrees on. A phone forty seconds fast
 * would otherwise show a hold expiring forty seconds early and hand back a
 * slot the customer still had.
 *
 * Every poll re-anchors it. Fifteen seconds is the longest this can drift from
 * the database's own view, and it drifts by however much the device's timer
 * ran slow — milliseconds.
 *
 * THIS IS DURATION ARITHMETIC, NOT CALENDAR ARITHMETIC. No timezones, no days,
 * no wall clock. The rule this project holds to is that the client never works
 * out when something IS; working out how long is left until an instant the
 * server named is exactly what a countdown is, and there is nowhere else it
 * could happen.
 */

export interface HoldCountdown {
  /** Whole seconds left, floored, never below zero. */
  secondsRemaining: number;
  /** 1 at the moment of the hold, 0 at the deadline. Drives the depleting bar. */
  fraction: number;
  /** Inside the last minute. */
  warning: boolean;
  /** The deadline has passed. */
  expired: boolean;
}

const IDLE: HoldCountdown = {
  secondsRemaining: 0,
  fraction: 0,
  warning: false,
  expired: false,
};

export function useHoldCountdown(hold: HoldSnapshot | null): HoldCountdown {
  /**
   * Milliseconds since this snapshot arrived, and which snapshot it is.
   *
   * `serverNow` is unique per response, so a poll fifteen seconds later
   * re-anchors the measurement even though the hold itself has not changed.
   * Reset during render — the pattern React documents for state that has to
   * follow a prop — rather than in an effect, so a new hold never renders once
   * with the previous hold's elapsed time subtracted from it.
   */
  const [tracked, setTracked] = useState({
    anchor: hold?.serverNow ?? null,
    elapsedMs: 0,
  });

  const anchor = hold?.serverNow ?? null;

  if (tracked.anchor !== anchor) {
    setTracked({ anchor, elapsedMs: 0 });
  }

  useEffect(() => {
    if (!anchor) {
      return;
    }

    /**
     * One second, and no requestAnimationFrame.
     *
     * The bar depletes linearly and honestly; it does not need sixty frames a
     * second to do that, and a booking page left open on a phone should not
     * keep the compositor awake for eight minutes. The `hold-bar` utility
     * carries the width smoothly between these steps, at exactly the rate the
     * seconds are passing.
     */
    const startedAt = Date.now();

    const timer = setInterval(() => {
      setTracked({ anchor, elapsedMs: Date.now() - startedAt });
    }, 1000);

    return () => clearInterval(timer);
  }, [anchor]);

  if (!hold) {
    return IDLE;
  }

  const expiresAt = Date.parse(hold.expiresAt);
  const remainingWhenSent = expiresAt - Date.parse(hold.serverNow);
  const totalMs = Math.max(expiresAt - Date.parse(hold.takenAt), 1);

  const remainingMs = remainingWhenSent - tracked.elapsedMs;

  return {
    secondsRemaining: Math.max(0, Math.floor(remainingMs / 1000)),
    fraction: Math.min(Math.max(remainingMs / totalMs, 0), 1),
    warning: remainingMs > 0 && remainingMs <= HOLD_WARNING_SECONDS * 1000,
    expired: remainingMs <= 0,
  };
}

/**
 * Seconds to "7:12".
 *
 * Set in Epilogue with tabular figures wherever it is rendered, so the digits
 * do not shuffle sideways as they change — a countdown that jitters reads as
 * broken, and this one is making a promise.
 */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;

  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
