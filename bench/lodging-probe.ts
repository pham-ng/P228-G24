/**
 * Khai báo lưu trú: can the front desk actually record and file one?
 *
 * `guest_registrations` has been empty since the table was created, because the
 * only writer was `declare_lodging` — a TOOL, so hosted-path only. This drives
 * the new staff endpoints over real HTTP.
 *
 * It deliberately checks the REFUSALS hardest. A declaration that looks filed
 * and is not is worse than a missing one, because it stops anyone asking: so
 * "submitted" must be unreachable without a receipt reference and without every
 * legally required field.
 *
 *   npx tsx bench/lodging-probe.ts
 */
import { storage, db } from "../server/storage";
import { guestRegistrations } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
const TOKEN = process.env.STAFF_API_TOKEN || "";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const before = new Set(storage.listRegistrations().map((r) => r.id));
const H = { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const get = (p: string) => fetch(`${BASE}${p}`, { headers: H }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));
const send = (m: string, p: string, b: unknown) =>
  fetch(`${BASE}${p}`, { method: m, headers: H, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const resv = storage.listReservations().find((r) => r.status === "in_house")!;

async function main() {
  console.log(`reservation ${resv.confirmationCode} (${resv.checkIn} → ${resv.checkOut})\n`);

  console.log("=== THE RULES COME FROM POLICY, NOT FROM A FORM ===");
  const reqVn = await get("/api/registrations/requirements?foreigner=0");
  const reqFo = await get("/api/registrations/requirements?foreigner=1");
  ok(reqVn.s === 200, "staff can read the requirement rules");
  ok(Array.isArray(reqVn.j.required) && reqVn.j.required.length > 0, "a Vietnamese guest has required fields");
  ok(
    reqFo.j.required.length > reqVn.j.required.length,
    `a foreign guest needs more (${reqFo.j.required.length} vs ${reqVn.j.required.length})`,
  );
  ok(
    reqFo.j.required.includes("visa_number") || reqFo.j.required.includes("entry_date"),
    "and those extras are the visa/entry fields",
  );
  ok(Array.isArray(reqFo.j.channels) && reqFo.j.channels.length > 0, "filing channels are listed");

  console.log("=== A COMPLETE FOREIGN DECLARATION ===");
  const full = await send("POST", "/api/registrations", {
    reservationId: resv.id,
    fullName: "PROBE Tanaka Yuki",
    idType: "passport",
    idNumber: "TZ9900011",
    nationality: "Japan",
    dob: "1990-05-05",
    permanentAddress: "1-1 Chiyoda, Tokyo",
    visaNumber: "DL123456",
    entryDate: "2026-08-20",
    entryPort: "Cam Ranh",
  });
  ok(full.s === 200, `it is accepted (got ${full.s})`);
  ok(full.j.isForeigner === 1, "a Japanese passport is classed as a foreign guest");
  ok((full.j.missing ?? []).length === 0, "nothing is missing");
  ok(full.j.status === "queued", `so it is ready to file, not merely collected (got "${full.j.status}")`);
  ok(full.j.submittedAt === null && full.j.receiptRef === null, "and NOT marked filed by the act of typing it");

  console.log("=== AN INCOMPLETE ONE IS HONEST ABOUT IT ===");
  const part = await send("POST", "/api/registrations", {
    reservationId: resv.id,
    fullName: "PROBE Incomplete",
    idType: "passport",
    idNumber: "TZ9900022",
    nationality: "Japan",
  });
  ok(part.s === 200, "it is still recorded — a partial record beats none");
  ok((part.j.missing ?? []).length > 0, `and names what is missing (${(part.j.missing ?? []).join(", ")})`);
  ok(part.j.status === "collected", "status is collected, not queued");

  console.log("=== 'SUBMITTED' IS HARD TO REACH, ON PURPOSE ===");
  const noRef = await send("PATCH", `/api/registrations/${full.j.id}`, { action: "submit", channel: "police_portal" });
  ok(noRef.s === 400, `filing without a receipt reference is refused (got ${noRef.s})`);
  const noChan = await send("PATCH", `/api/registrations/${full.j.id}`, { action: "submit", receiptRef: "R-1" });
  ok(noChan.s === 400, `filing without saying where is refused (got ${noChan.s})`);
  const incomplete = await send("PATCH", `/api/registrations/${part.j.id}`, {
    action: "submit", channel: "vneid", receiptRef: "R-2",
  });
  ok(incomplete.s === 409, `an incomplete declaration cannot be marked filed (got ${incomplete.s})`);
  ok(Array.isArray(incomplete.j.missing), "and the refusal says which fields are still blank");

  console.log("=== FILLING THE GAPS THEN FILING ===");
  const filled = await send("PATCH", `/api/registrations/${part.j.id}`, {
    action: "update", dob: "1988-02-02", permanentAddress: "2-2 Osaka",
    visaNumber: "DL654321", entryDate: "2026-08-21", entryPort: "Cam Ranh",
  });
  ok((filled.j.missing ?? []).length === 0, "the gaps close");
  ok(filled.j.status === "queued", "and it becomes ready to file");
  const filed = await send("PATCH", `/api/registrations/${part.j.id}`, {
    action: "submit", channel: "police_portal", receiptRef: "PROBE-RCPT-77",
  });
  ok(filed.s === 200 && filed.j.status === "submitted", "now it files");
  ok(filed.j.receiptRef === "PROBE-RCPT-77" && !!filed.j.submittedAt, "with a receipt and a timestamp");

  console.log("=== THE LIST CARRIES THE LEGAL CLOCK ===");
  const list = await get("/api/registrations");
  const mine = list.j.find((r: any) => r.id === full.j.id);
  ok(!!mine, "the new record is listed");
  ok(!!mine.dueAt, "each row carries a deadline computed from arrival + policy hours");
  ok(mine.confirmationCode === resv.confirmationCode, "and enough context to find the guest");

  /* --- cleanup --- */
  const created = storage.listRegistrations().filter((r) => !before.has(r.id)).map((r) => r.id);
  if (created.length) db.delete(guestRegistrations).where(inArray(guestRegistrations.id, created)).run();
  console.log(`\ncleaned up ${created.length} registration(s)`);

  console.log(failures === 0 ? "\nALL LODGING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  const created = storage.listRegistrations().filter((r) => !before.has(r.id)).map((r) => r.id);
  if (created.length) db.delete(guestRegistrations).where(inArray(guestRegistrations.id, created)).run();
  console.error("probe threw:", e?.message ?? e, `(cleaned up ${created.length})`);
  process.exit(1);
});
