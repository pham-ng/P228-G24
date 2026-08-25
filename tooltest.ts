/**
 * Checks the tool router on realistic kiosk messages in Vietnamese, English,
 * Korean and Chinese: does the right family get selected, does the budget hold,
 * does an unlocked family survive a follow-up with no keywords in it, and does
 * find_capability recover from a routing miss.
 */
/* TOOLS_SPEC may name a .json dump of the tool list instead of agent.ts. Node's
   native TypeScript runner does not resolve extensionless relative imports, and
   agent.ts reaches ./storage -> ./db -> better-sqlite3, so on the Windows kiosk
   the whole server would have to boot just to read a tool list. toolrouter.ts
   has only a type-only import, so router + JSON dump runs wherever Node runs.
   Regenerate the dump with: npx tsx dump-tools.ts */
const spec = process.env.TOOLS_SPEC ?? "./server/agent";
const rspec = process.env.ROUTER_SPEC ?? "./server/toolrouter";
const TOOLS: typeof import("./server/agent").TOOLS = spec.endsWith(".json")
  ? JSON.parse(await (await import("node:fs/promises")).readFile(spec, "utf8"))
  : ((await import(spec)) as typeof import("./server/agent")).TOOLS;
const R = (await import(rspec)) as typeof import("./server/toolrouter");

let failed = 0;
const pass = (b: boolean, m: string) => {
  if (!b) failed++;
  console.log((b ? "  PASS  " : "  FAIL  ") + m);
};

console.log(
  `full set ${TOOLS.length} tools = ${R.estimateTokens(TOOLS)} tok (est) | ` +
    `budget local ${R.TOOL_BUDGET.local} / api ${R.TOOL_BUDGET.openai}\n`,
);

/* --- every tool reachable, nothing invented ------------------------------- */
const names = new Set(TOOLS.map((t) => t.function.name));
const grouped = Object.values(R.FAMILIES).flat();
pass(grouped.length === TOOLS.length, `all ${TOOLS.length} tools are in exactly one family`);
pass(new Set(grouped).size === grouped.length, "no tool is listed in two families");
pass(grouped.every((n) => names.has(n)), "no family names a tool that does not exist");

/* --- the largest family must fit the local budget ------------------------- */
const big = R.selectTools({ text: "tôi muốn ở thêm một đêm", all: TOOLS, provider: "local" });
pass(
  big.families.includes("stay_changes") && big.tokens <= R.TOOL_BUDGET.local,
  `the biggest family fits the 8K local budget (${big.tokens} <= ${R.TOOL_BUDGET.local})`,
);

/* --- routing across the four kiosk languages ----------------------------- */
const cases: Array<[string, string, R_Family]> = [
  ["vi", "Tôi muốn trả phòng muộn đến 3 giờ chiều có được không?", "stay_changes"],
  ["vi", "Cho tôi xem hoá đơn phòng tôi hiện bao nhiêu tiền", "billing"],
  ["vi", "Điều hoà phòng tôi không lạnh, nhờ sửa giúp", "housekeeping"],
  ["vi", "Nhà hàng buffet sáng mở cửa mấy giờ?", "dining_services"],
  ["vi", "Tôi cần xe đưa ra sân bay lúc 5h sáng mai", "transport_tours"],
  ["vi", "Villa 3 phòng ngủ có ban công hướng biển không?", "rooms_info"],
  ["vi", "Tôi là thành viên Platinum, còn bao nhiêu điểm?", "guest_profile"],
  ["en", "Can I get a late checkout tomorrow?", "stay_changes"],
  ["en", "Please send my invoice to my email", "billing"],
  ["en", "The shower is leaking and the towels were not replaced", "housekeeping"],
  ["en", "What time does the spa close?", "dining_services"],
  ["ko", "레이트 체크아웃 가능한가요?", "stay_changes"],
  ["ko", "계산서를 보여주세요", "billing"],
  ["ko", "에어컨이 고장났어요", "housekeeping"],
  ["ko", "공항 픽업 예약하고 싶어요", "transport_tours"],
  ["zh", "我想延迟退房到下午三点", "stay_changes"],
  ["zh", "请给我发票", "billing"],
  ["zh", "空调坏了，房间太热", "housekeeping"],
  ["zh", "早餐几点开始？", "dining_services"],
  ["zh", "我要接机服务", "transport_tours"],
];
type R_Family = Parameters<typeof R.selectTools>[0]["active"] extends (infer U)[] | undefined ? U : never;

let routed = 0;
for (const [lang, text, want] of cases) {
  const sel = R.selectTools({ text, all: TOOLS, provider: "local" });
  const ok = sel.families.includes(want) && sel.tokens <= R.TOOL_BUDGET.local;
  if (ok) routed++;
  else console.log(`         miss [${lang}] "${text}" -> ${sel.families.join(",")} (wanted ${want})`);
}
pass(routed === cases.length, `${routed}/${cases.length} messages routed to the right family in vi/en/ko/zh`);

/* --- urgent outranks the budget ------------------------------------------ */
const med = R.selectTools({
  text: "Vợ tôi bị dị ứng, cần bác sĩ ngay",
  all: TOOLS,
  provider: "local",
  budget: 900, // absurdly tight on purpose
});
pass(
  med.families.includes("urgent") && med.tools.some((t) => t.function.name === "request_medical_assistance"),
  "a medical request keeps its tool even when the budget cannot afford it",
);

/* --- core and the escape hatch are unconditional ------------------------- */
const bare = R.selectTools({ text: "hello", all: TOOLS, provider: "local" });
for (const n of ["escalate_to_human", "get_policy", "search_knowledge", "get_stay_details", "find_capability"]) {
  pass(bare.tools.some((t) => t.function.name === n), `${n} is present on a turn with no cue`);
}
pass(bare.guessed, "a message with no cue is reported as guessed, not silently narrowed");

/* --- a follow-up with no keywords must not lose the topic ---------------- */
const follow = R.selectTools({ text: "vâng, đúng rồi bạn", all: TOOLS, active: ["billing"], provider: "local" });
pass(
  follow.families.includes("billing"),
  "an unlocked family survives a keyword-free follow-up like 'vâng, đúng rồi'",
);

/* --- find_capability recovers a routing miss ----------------------------- */
const missSel = R.selectTools({ text: "chào bạn", all: TOOLS, provider: "local" });
pass(!missSel.families.includes("billing"), "billing is not loaded for a bare greeting");
const found = R.resolveFindCapability("issue a VAT invoice for my company", TOOLS);
pass(
  found.families.includes("billing") && found.tools.some((t) => t.name === "request_invoice"),
  `find_capability finds the invoice tool and unlocks billing (${found.families.join(",")})`,
);
const foundVi = R.resolveFindCapability("đặt xe đưa ra sân bay", TOOLS);
pass(foundVi.families.includes("transport_tours"), "find_capability works from a Vietnamese need");
const foundNone = R.resolveFindCapability("zzzz qqqq", TOOLS);
pass(
  foundNone.families.length > 1,
  "an unmatchable need lists every family rather than answering 'not found'",
);

/* --- budget is respected under a multi-intent message -------------------- */
const multi = R.selectTools({
  text: "Tôi muốn ở thêm 1 đêm, xem hoá đơn, đặt bàn tối và nhờ dọn phòng, và cần xe ra sân bay",
  all: TOOLS,
  provider: "local",
});
pass(multi.tokens <= R.TOOL_BUDGET.local, `a five-intent message still fits the budget (${multi.tokens})`);
pass(multi.dropped.length > 0, `families that did not fit are reported as dropped (${multi.dropped.join(",")})`);
/* The invariant is that the strongest intent survives the packing — not any
   particular family. A cheap family must never crowd out the top one, which is
   what happened before the top-scored family was admitted first. */
const topFamily = R.scoreFamilies(
  "Tôi muốn ở thêm 1 đêm, xem hoá đơn, đặt bàn tối và nhờ dọn phòng, và cần xe ra sân bay",
)[0].family;
pass(
  multi.families.includes(topFamily),
  `the strongest intent (${topFamily}) survives when the intents cannot all fit`,
);
pass(
  R.resolveFindCapability("ở thêm một đêm nữa", TOOLS).families.includes("stay_changes"),
  "a family dropped for budget is still recoverable through find_capability",
);

/* --- cue hygiene: the failures that only show up in ko/zh ---------------- */
const allCues = R.cueList();
const cjk1 = allCues.filter(
  (c) => /[\p{Script=Han}\p{Script=Hangul}]/u.test(c) && [...c].length < 2,
);
pass(
  cjk1.length === 0,
  `no Korean/Chinese cue is a single character (single chars match inside unrelated words)${cjk1.length ? ": " + cjk1.join(",") : ""}`,
);

const falsePositives: Array<[string, string, R_Family]> = [
  ["ko", "예약을 변경하고 싶어요", "urgent"],
  ["ko", "서비스가 어떻게 되나요", "rooms_info"],
  ["vi", "Món này có nước sốt gì không?", "urgent"],
  ["vi", "Cho tôi xem hoá đơn", "transport_tours"],
];
let clean = 0;
for (const [lang, text, mustNot] of falsePositives) {
  const fams = R.scoreFamilies(text).map((s) => s.family);
  if (!fams.includes(mustNot)) clean++;
  else console.log(`         false positive [${lang}] "${text}" -> ${mustNot}`);
}
pass(clean === falsePositives.length, `${clean}/${falsePositives.length} known false-positive traps avoided`);

/* --- the saving is real -------------------------------------------------- */
const fullTok = R.estimateTokens(TOOLS);
const apiSel = R.selectTools({ text: "cho tôi xem hoá đơn", all: TOOLS, provider: "openai" });
const savedPct = Math.round((1 - apiSel.tokens / fullTok) * 100);
pass(savedPct >= 30, `the hosted path sends ${apiSel.tokens} instead of ${fullTok} tokens, ${savedPct}% less per round`);
pass(
  R.selectTools({ text: "cho tôi xem hoá đơn", all: TOOLS, provider: "local" }).tokens <
    R.TOOL_BUDGET.local,
  "the local path stays under its own tighter ceiling",
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
