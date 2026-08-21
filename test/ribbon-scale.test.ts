import { describe, expect, it } from "vitest";

import {
  DEFAULT_PX_PER_MIN,
  MIN_TOUCH_TARGET_PX,
  bodyHeightPx,
  gridlineMinutes,
  hitAreaInsetPx,
  lengthPx,
  offsetPx,
  windowDuration,
} from "@/components/ribbon/scale";

/**
 * The Ribbon's geometry.
 *
 * These are the rules the signature component rests on: time is drawn to a
 * fixed scale so quantities of the day are comparable by eye, and a slot too
 * short to press is still drawn at its true size. Both are easy to break with
 * a well-meaning "just round it up", so both are pinned here.
 */

const WORKDAY = { startMinute: 9 * 60, endMinute: 17 * 60 };

describe("the scale is proportional", () => {
  it("draws a 90-minute service at three times a 30-minute one", () => {
    const long = lengthPx(90, DEFAULT_PX_PER_MIN);
    const short = lengthPx(30, DEFAULT_PX_PER_MIN);

    expect(long).toBe(short * 3);
  });

  it("is linear at any scale, not just the default", () => {
    for (const pxPerMin of [0.8, 1.6, 2.5, 4]) {
      expect(lengthPx(120, pxPerMin)).toBe(lengthPx(60, pxPerMin) * 2);
    }
  });

  it("places a minute at its distance from the top of the window", () => {
    // 10:30 is 90 minutes into a day that starts at 09:00.
    expect(offsetPx(10 * 60 + 30, WORKDAY, DEFAULT_PX_PER_MIN)).toBe(
      90 * DEFAULT_PX_PER_MIN,
    );
  });

  it("puts the start of the window at the very top", () => {
    expect(offsetPx(WORKDAY.startMinute, WORKDAY, DEFAULT_PX_PER_MIN)).toBe(0);
  });

  it("gives the body a height the window can be read off", () => {
    expect(windowDuration(WORKDAY)).toBe(480);
    expect(bodyHeightPx(WORKDAY, DEFAULT_PX_PER_MIN)).toBe(
      480 * DEFAULT_PX_PER_MIN,
    );
  });
});

describe("short segments stay honest but stay pressable", () => {
  it("expands the hit area of a segment drawn shorter than 44px", () => {
    // The case this exists for: a 15-minute slot is 24px at the default scale.
    const drawn = lengthPx(15, DEFAULT_PX_PER_MIN);
    expect(drawn).toBe(24);

    const inset = hitAreaInsetPx(drawn);

    // The drawing does not change; the target reaches 44px.
    expect(drawn + inset * 2).toBe(MIN_TOUCH_TARGET_PX);
  });

  it("leaves a segment that is already big enough alone", () => {
    const drawn = lengthPx(60, DEFAULT_PX_PER_MIN);

    expect(hitAreaInsetPx(drawn)).toBe(0);
  });

  it("never shrinks a hit area, even exactly at the threshold", () => {
    expect(hitAreaInsetPx(MIN_TOUCH_TARGET_PX)).toBe(0);
    expect(hitAreaInsetPx(MIN_TOUCH_TARGET_PX + 100)).toBe(0);
  });
});

describe("gridlines are ruled on the clock", () => {
  it("puts an hour line on every hour in the window", () => {
    expect(gridlineMinutes(WORKDAY, 60)).toEqual([
      540, 600, 660, 720, 780, 840, 900, 960, 1020,
    ]);
  });

  it("starts on the clock, not on the window edge", () => {
    // A window opening at 08:20 still rules its first line at 09:00.
    const ragged = { startMinute: 8 * 60 + 20, endMinute: 11 * 60 };

    expect(gridlineMinutes(ragged, 60)).toEqual([540, 600, 660]);
  });

  it("interleaves half hours with the hours", () => {
    const halves = gridlineMinutes(WORKDAY, 30).filter(
      (minute) => minute % 60 !== 0,
    );

    expect(halves).toEqual([570, 630, 690, 750, 810, 870, 930, 990]);
  });
});
