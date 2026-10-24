/**
 * Bulk support mark (COST-SUPPORT-1024-EXPERTQUOTES): every run of this
 * service since 2026-02-02 is the retired PR product (Featured/Connectively
 * pitch submits, $2,229.72 spent 2026-06 -> 2026-08), so it is marked
 * `retired_product` on runs-service's owner door and stays off every cost
 * per outcome. Idempotent: runs-service keeps an already marked run as is,
 * and never marks a run that declared a produced outcome (counted, printed).
 *
 * Runs inside the container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY set):
 *   node dist/scripts/mark-retired-support.js            # preview only
 *   node dist/scripts/mark-retired-support.js --apply    # mark
 */
import {
  applySupportMarks,
  previewSupportMarks,
  type SupportMarkRequest,
} from "../lib/runs-client.js";

export const SERVICE_NAME = "expert-quotes-requests-service";
export const LEDGER_START = "2026-02-02T00:00:00.000Z";
const WINDOW_DAYS = 7; // one week of runs stays well under runs-service's 50,000 per apply

export const MARK: Omit<SupportMarkRequest, "startedAfter" | "startedBefore"> = {
  kind: "retired_product",
  reason:
    "Retired PR product: Featured/Connectively expert-quote pitch submits and their feed reads. The product is no longer sold; its spend produces no catalogue outcome.",
  markedBy: "COST-SUPPORT-1024-EXPERTQUOTES (owner go 2026-10-24)",
};

/** Contiguous [start, end) windows of `days` days covering [from, to). */
export function weekWindows(from: Date, to: Date, days = WINDOW_DAYS): Array<{ startedAfter: string; startedBefore: string }> {
  const out: Array<{ startedAfter: string; startedBefore: string }> = [];
  const step = days * 24 * 3600 * 1000;
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    out.push({
      startedAfter: new Date(t).toISOString(),
      startedBefore: new Date(Math.min(t + step, to.getTime())).toISOString(),
    });
  }
  return out;
}

const usd = (cents: string) => `$${(Number(cents) / 100).toFixed(2)}`;

async function main(apply: boolean) {
  const now = new Date();
  const whole = { ...MARK, startedAfter: LEDGER_START, startedBefore: now.toISOString() };
  const before = await previewSupportMarks(SERVICE_NAME, { ...whole, withSpendOnly: true });
  console.log(
    `[before] runs with spend still to mark: ${before.toMarkCount} (${usd(before.spend.grossCents)} gross, ${usd(before.spend.netCents)} net), already marked: ${before.alreadyMarkedCount}, declaring an outcome (never marked): ${before.declaresOutcomesCount}, riding an outcome today: ${before.onOutcomeNowCount}`
  );
  if (!apply) return;

  let marked = 0;
  let alreadyMarked = 0;
  let declares = 0;
  for (const w of weekWindows(new Date(LEDGER_START), now)) {
    const r = await applySupportMarks(SERVICE_NAME, { ...MARK, ...w });
    marked += r.markedCount;
    alreadyMarked += r.alreadyMarkedCount;
    declares += r.declaresOutcomesCount ?? 0;
    if (r.markedCount > 0) console.log(`[apply] ${w.startedAfter.slice(0, 10)}: marked ${r.markedCount}`);
  }
  console.log(`[apply] marked ${marked}, already marked ${alreadyMarked}, declaring an outcome (left out) ${declares}`);

  const after = await previewSupportMarks(SERVICE_NAME, { ...whole, withSpendOnly: true });
  console.log(
    `[after] runs with spend still to mark: ${after.toMarkCount} (${usd(after.spend.grossCents)}), already marked: ${after.alreadyMarkedCount}`
  );
  if (after.toMarkCount !== 0) throw new Error(`${after.toMarkCount} runs with spend left unmarked`);
}

if (process.argv[1]?.endsWith("mark-retired-support.js") || process.argv[1]?.endsWith("mark-retired-support.ts")) {
  main(process.argv.includes("--apply")).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
