import { describe, expect, it } from "vitest";
import { resolveCalendarIdsToQuery } from "./googleCalendarSelection";

const cal = (id: string, primary = false) => ({ id, primary });

describe("resolveCalendarIdsToQuery", () => {
  it("returns nothing when not connected", () => {
    expect(resolveCalendarIdsToQuery(false, [cal("a", true)], ["b"])).toEqual([]);
  });

  it("falls back to primary while the calendar list is missing or empty", () => {
    expect(resolveCalendarIdsToQuery(true, undefined, ["b"])).toEqual(["primary"]);
    expect(resolveCalendarIdsToQuery(true, [], ["b"])).toEqual(["primary"]);
  });

  it("queries primary plus selected calendars that still exist", () => {
    const list = [cal("me@x.com", true), cal("shared@group.calendar.google.com")];
    expect(resolveCalendarIdsToQuery(true, list, ["shared@group.calendar.google.com"])).toEqual([
      "me@x.com",
      "shared@group.calendar.google.com",
    ]);
  });

  it("drops selected ids that are no longer in the calendar list (deleted/unshared)", () => {
    const list = [cal("me@x.com", true)];
    expect(resolveCalendarIdsToQuery(true, list, ["gone@group.calendar.google.com"])).toEqual(["me@x.com"]);
  });

  it("does not duplicate the primary calendar when it is also selected", () => {
    const list = [cal("me@x.com", true)];
    expect(resolveCalendarIdsToQuery(true, list, ["me@x.com"])).toEqual(["me@x.com"]);
  });
});
