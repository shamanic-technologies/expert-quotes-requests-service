import { describe, it, expect } from "vitest";
import {
  readStr,
  readInt,
  readDate,
  safeParseDate,
  MEDIA_OUTLET_KEYS,
} from "../../src/lib/featured-normalize.js";

describe("featured field normalizers", () => {
  it("readStr returns the first non-empty string among the given keys", () => {
    expect(readStr({ a: "", b: "  ", c: "hit" }, "a", "b", "c")).toBe("hit");
    expect(readStr({ a: "first" }, "a", "b")).toBe("first");
    expect(readStr({}, "a", "b")).toBeNull();
    expect(readStr({ a: 5 }, "a")).toBeNull(); // non-string ignored
  });

  it("readStr with MEDIA_OUTLET_KEYS captures the outlet under any known alias", () => {
    expect(readStr({ mediaOutlet: "Camel" }, ...MEDIA_OUTLET_KEYS)).toBe(
      "Camel"
    );
    expect(readStr({ media_outlet: "Snake" }, ...MEDIA_OUTLET_KEYS)).toBe(
      "Snake"
    );
    expect(readStr({ outlet: "Bare" }, ...MEDIA_OUTLET_KEYS)).toBe("Bare");
    expect(readStr({ publication: "Pub" }, ...MEDIA_OUTLET_KEYS)).toBe("Pub");
    expect(readStr({ publisher: "Pubr" }, ...MEDIA_OUTLET_KEYS)).toBe("Pubr");
    // S2: no outlet under any alias → null (never fabricated)
    expect(
      readStr({ question: "q", featuredQuestionId: 1 }, ...MEDIA_OUTLET_KEYS)
    ).toBeNull();
  });

  it("readInt coerces integer-like values and ignores the rest", () => {
    expect(readInt({ a: 42 }, "a")).toBe(42);
    expect(readInt({ a: "42" }, "a")).toBe(42);
    expect(readInt({ a: "x", b: 7 }, "a", "b")).toBe(7);
    expect(readInt({ a: 1.5 }, "a")).toBeNull();
    expect(readInt({}, "a")).toBeNull();
  });

  it("readDate / safeParseDate parse ISO-ish strings and null on garbage", () => {
    expect(readDate({ d: "2026-06-01" }, "d")?.getUTCFullYear()).toBe(2026);
    expect(readDate({ d: "not a date" }, "d")).toBeNull();
    expect(safeParseDate("2026-06-01T00:00:00.000Z")).not.toBeNull();
    expect(safeParseDate(12345)).toBeNull();
    expect(safeParseDate(null)).toBeNull();
  });
});
