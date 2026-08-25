/**
 * Tests the numeric fabrication guard on the cases that actually matter for a
 * hotel kiosk: real prices from tool results must pass, invented ones must be
 * caught, and the things that merely look like prices — reservation codes, room
 * numbers, phone numbers, guest counts — must not be treated as claims.
 */
const gspec = process.env.GUARD_SPEC ?? "./server/numguard";
const G = (await import(gspec)) as typeof import("./server/numguard");

let failed = 0;
const pass = (b: boolean, m: string) => {
  if (!b) failed++;
  console.log((b ? "  PASS  " : "  FAIL  ") + m);
};

/* Shaped like real results from get_folio / get_stay_details / get_policy. */
const folio = {
  reservation_code: "VPNT-1D40TG",
  room: "V03",
  balance_due: 47877000,
  lines: [
    { desc: "Villa 3-Bedroom Ocean View", amount: 12000000, nights: 3 },
    { desc: "Spa — signature massage", amount: 2300000 },
  ],
  currency: "VND",
};
const policy = { check_in: "14:00", check_out: "12:00", vat_rate: 8, service_charge: 5 };
const ev = { toolResults: [folio, policy], guestText: "Tôi đi 2 người, ở 3 đêm" };

/* --- grounded numbers survive -------------------------------------------- */
pass(
  G.checkReply("Số dư hiện tại của quý khách là 47.877.000 ₫.", ev).ok,
  "a balance taken from the folio passes",
);
pass(
  G.checkReply("Buổi massage là 2.300.000 ₫, nhận phòng từ 14:00.", ev).ok,
  "a line-item price and the standard check-in time pass",
);
pass(G.checkReply("VAT là 8% và phí phục vụ 5%.", ev).ok, "the real VAT and service-charge rates pass");

/* --- the fabrication we know is in the database -------------------------- */
const spa = G.checkReply(
  "Hạng Platinum được giảm 30%, nên 2.300.000 ₫ chỉ còn 1.610.000 ₫.",
  ev,
);
pass(
  !spa.ok && spa.ungrounded.some((c) => c.value === "1610000"),
  "the unconditional Platinum spa price from brand_voice is caught (30% is a real\n         rate, but the discounted amount has to come from pricing.ts, not from the\n         guard multiplying it out)",
);
pass(
  G.checkReply("Phòng này giá 5.500.000 ₫ một đêm.", ev).ungrounded.length === 1,
  "a rate that appears in no tool result is caught",
);
/* KNOWN LIMIT, asserted rather than hidden: a bare count like "476 phòng" is
   not a money/percent/time claim, so this guard does not check it. The invented
   "476-key" line in brand_voice therefore still needs the data fix; catching it
   would mean checking every integer, which would also flag "2 người". */
pass(
  G.checkReply("Resort c\u00f3 476 ph\u00f2ng.", ev).checked === 0,
  "a bare room count is out of scope by design, not silently mis-handled",
);
pass(
  !G.checkReply("Chúng tôi giảm 45% cho quý khách.", ev).ok,
  "a discount rate the hotel does not offer is caught",
);
pass(
  !G.checkReply("Quý khách có thể nhận phòng từ 09:00.", ev).ok,
  "an invented check-in time is caught",
);

/* --- arithmetic the hotel really does ------------------------------------ */
pass(
  G.checkReply("12.000.000 ₫ cộng phí phục vụ và VAT là 13.608.000 ₫.", ev).ok,
  "a subtotal grossed up by 5% service charge then 8% VAT passes",
);
pass(
  G.checkReply("Nhận phòng sớm tính 50% giá phòng, tức 6.000.000 ₫.", ev).ok,
  "half of a grounded rate passes, since early check-in is 50%",
);

/* --- things that look numeric but are not claims ------------------------- */
pass(
  G.checkReply("Mã đặt phòng VPNT-1D40TG, villa V03, gọi 0258 3598 888 nhé.", ev).ok,
  "reservation code, villa number and phone number are not read as prices",
);
pass(
  G.checkReply("Quý khách đi 2 người và ở 3 đêm, đúng không?", ev).ok,
  "guest counts and night counts are not checked",
);
pass(
  G.checkReply("Lễ tân hỗ trợ 24/7 và trả lời trong vòng 10 phút.", ev).ok,
  "24/7 and a small SLA number are not read as prices",
);
pass(
  G.checkReply("Ngày đi là 2026-08-25, tức 25/08/2026.", ev).ok,
  "dates in both formats are not read as prices",
);

/* --- separators and "triệu" all normalise the same way ------------------- */
for (const written of ["2.300.000", "2,300,000", "2300000", "2300000 ₫", "2,3 triệu"]) {
  pass(G.checkReply(`Giá là ${written}.`, ev).ok, `"${written}" matches the same grounded amount`);
}

/* --- the prompt is not a grounding source -------------------------------- */
const noTools = { toolResults: [], guestText: "" };
pass(
  !G.checkReply("Giá massage là 2.300.000 ₫.", noTools).ok,
  "with no tool call, even a real price is unsupported — the prompt does not count",
);

/* --- repair keeps the good half ----------------------------------------- */
const draft =
  "Nhận phòng từ 14:00 ạ. Hạng Platinum giảm 30% nên còn 1.610.000 ₫. Bể bơi mở đến 21:00.";
const rep = G.repairReply(draft, G.checkReply(draft, ev));
pass(!rep.text.includes("1.610.000"), "the invented figure is removed from the reply");
pass(rep.text.includes("14:00"), "the grounded sentence is kept");
pass(rep.escalate, "the turn escalates so a human confirms the number");
pass(rep.removed.length === 1, "exactly the offending sentence is reported as removed");

const allBad = "Giá phòng là 5.500.000 ₫.";
const rep2 = G.repairReply(allBad, G.checkReply(allBad, ev));
pass(
  rep2.escalate && !rep2.text.includes("5.500.000"),
  "a reply that was nothing but an invented price becomes an escalation",
);

/* --- guest-stated numbers may be read back ------------------------------ */
pass(
  G.checkReply("Vâng, ngân sách 3.000.000 ₫ một đêm thì có mấy lựa chọn.", {
    toolResults: [],
    guestText: "Ngân sách của tôi khoảng 3.000.000 một đêm",
  }).ok,
  "a number the guest supplied can be echoed back",
);

/* --- brand_voice in the live DB must not contain money or percent claims ---
 *
 * hotels.brand_voice is embedded verbatim into the system prompt by
 * buildSystemPrompt(). numguard deliberately excludes the prompt as a grounding
 * source (see file comment in numguard.ts), so any money or percent figure that
 * appears there would be caught at runtime and cause unnecessary escalations.
 * Migration 002-brand-voice.ts removes the two known fabricated claims; this
 * test makes sure they do not creep back in.
 *
 * Note: time claims (e.g. "09:00") in brand_voice are fine — they are a subset
 * of HOUSE_CONSTANTS.times and will ground correctly, so we do not block them.
 */
import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

let brandVoice = "";
try {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT brand_voice FROM hotels LIMIT 1").get() as
    | { brand_voice: string }
    | undefined;
  brandVoice = row?.brand_voice ?? "";
  db.close();
} catch {
  brandVoice = "";
}

if (!brandVoice) {
  console.log("  NOTE  hotels table empty or DB not found — brand_voice DB tests skipped.");
} else {
  const bvClaims = G.extractClaims(brandVoice);
  const bvMoney = bvClaims.filter((c) => c.kind === "money");
  const bvPercent = bvClaims.filter((c) => c.kind === "percent");

  pass(
    bvMoney.length === 0,
    `hotels.brand_voice contains no money claims after migration — fabricated amounts removed (found: ${bvMoney.map((c) => c.raw).join(", ") || "none"})`
  );
  pass(
    bvPercent.length === 0,
    `hotels.brand_voice contains no percent claims after migration — discount percentages removed (found: ${bvPercent.map((c) => c.raw).join(", ") || "none"})`
  );
}

/* --- P1 remediation: natural-language time echoed back must not fabricate -- */
/* Measured directly on a 105-case hosted benchmark: a guest saying "4 giờ
   chiều" never produced a TIME claim (TIME_RE only matches H:MM), so when the
   model correctly converted it to "16:00" the guard had nothing to match
   against and reported a fabrication on the guest's own restated time. Three
   separate benchmark cases failed this exact way. */
/* The band boundary (e.g. "18:00") is a policy fact, not something the guest
   said — it is grounded through a tool result here exactly as
   quote_late_checkout's real output would, same as the live system. Only the
   guest's OWN stated time relies on the guestText grounding path this fix
   adds. */
const lateCheckoutQuote = { band: "12:00–18:00", fee_pct: 50, standard_checkout_time: "12:00" };
const checkoutTimeEv = { toolResults: [policy, lateCheckoutQuote], guestText: "Tôi muốn trả phòng lúc 4 giờ chiều" };
pass(
  G.checkReply("Lúc 16:00 thuộc khung 12:00–18:00, phí là 50%.", checkoutTimeEv).ok,
  "the model's 24-hour conversion of the guest's own '4 giờ chiều' is not flagged",
);
const earlyCheckinEv = { toolResults: [policy], guestText: "Tôi tới lúc 4 giờ sáng thì tính phí thế nào?" };
pass(
  G.checkReply("Nếu tới lúc 04:00 thì tính 100% giá gói.", earlyCheckinEv).ok,
  "'4 giờ sáng' restated as 04:00 is not flagged",
);
const afterEighteen = { band: "sau 18:00", fee_pct: 100 };
const eveningEv = { toolResults: [policy, afterEighteen], guestText: "Trả phòng lúc 8 giờ tối thì sao?" };
pass(
  G.checkReply("20:00 thuộc khung sau 18:00, tính 100%.", eveningEv).ok,
  "'8 giờ tối' restated as 20:00 is not flagged",
);
/* A genuinely unsupported time must still be caught — the fix targets the
   guest's own stated time only, not every clock time in a reply. */
pass(
  !G.checkReply("Chúng tôi có thể miễn phí đến 22:00 cho mọi khách.", checkoutTimeEv).ok,
  "an invented time the guest never mentioned is still flagged",
);

/* --- P1 remediation: a bare calendar year is not a fabricated price -------- */
/* "Q13-ja-stay": asked in Japanese how many nights remain, the model's answer
   named the year (2026) and the guard read the four-digit number as an
   invented price with no currency mark, escalating an answerable question. */
const yearEv = { toolResults: [{ check_out: "2026-08-20" }], guestText: "何日まで滞在できますか" };
pass(
  G.checkReply("ご滞在は2026年8月20日までです。", yearEv).ok,
  "a bare calendar year in the reply is not read as a fabricated price",
);
pass(
  G.extractClaims("trong năm 2026 chúng tôi có chương trình mới").every((c) => c.kind !== "money"),
  "a bare year outside any tool result still does not register as a money claim",
);
/* A real, currency-marked amount that happens to fall in the year range must
   still be caught — this only strips the false positive, not real money. */
pass(
  G.extractClaims("phí phạt là 2026đ").some((c) => c.kind === "money" && c.value === "2026"),
  "a currency-marked amount in the year-like range is still read as money",
);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
