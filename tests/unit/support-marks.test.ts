import { describe, it, expect, vi, beforeAll } from "vitest";

beforeAll(() => {
  process.env.RUNS_SERVICE_URL = "http://runs.test";
  process.env.RUNS_SERVICE_API_KEY = "runs-key";
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("runs-client support marks (owner door)", () => {
  it("previews and applies on the owner door with x-service-name and the mark body", async () => {
    vi.resetModules();
    const { previewSupportMarks, applySupportMarks } = await import("../../src/lib/runs-client.js");
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return url.endsWith("/preview")
        ? jsonResponse({ matchedRunCount: 2, toMarkCount: 2, alreadyMarkedCount: 0, declaresOutcomesCount: 0, onOutcomeNowCount: 0, spend: { grossCents: "200", netCents: "200" }, maxRuns: 50000, tooMany: false })
        : jsonResponse({ markedCount: 2, alreadyMarkedCount: 0, declaresOutcomesCount: 0 });
    });
    const body = { kind: "retired_product" as const, reason: "r", markedBy: "m", withSpendOnly: true };

    const p = await previewSupportMarks("expert-quotes-requests-service", body, fetchImpl as unknown as typeof fetch);
    const a = await applySupportMarks("expert-quotes-requests-service", body, fetchImpl as unknown as typeof fetch);

    expect(p.toMarkCount).toBe(2);
    expect(a.markedCount).toBe(2);
    expect(calls.map((c) => c.url)).toEqual([
      "http://runs.test/v1/platform-runs/support-marks/preview",
      "http://runs.test/v1/platform-runs/support-marks/apply",
    ]);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe("runs-key");
      expect(c.headers["x-service-name"]).toBe("expert-quotes-requests-service");
      expect(c.body).toEqual(body);
    }
  });

  it("fails loud on a refused mark", async () => {
    vi.resetModules();
    const { applySupportMarks } = await import("../../src/lib/runs-client.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "too_many_runs" }, 422));
    await expect(
      applySupportMarks("expert-quotes-requests-service", { kind: "retired_product", reason: "r", markedBy: "m" }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/support-marks\/apply failed \(422\)/);
  });
});

describe("mark-retired-support windows", () => {
  it("covers [from, to) contiguously with no gap or overlap", async () => {
    const { weekWindows, MARK } = await import("../../src/scripts/mark-retired-support.js");
    const w = weekWindows(new Date("2026-02-02T00:00:00Z"), new Date("2026-02-20T12:00:00Z"));
    expect(w).toEqual([
      { startedAfter: "2026-02-02T00:00:00.000Z", startedBefore: "2026-02-09T00:00:00.000Z" },
      { startedAfter: "2026-02-09T00:00:00.000Z", startedBefore: "2026-02-16T00:00:00.000Z" },
      { startedAfter: "2026-02-16T00:00:00.000Z", startedBefore: "2026-02-20T12:00:00.000Z" },
    ]);
    expect(MARK.kind).toBe("retired_product");
  });
});
