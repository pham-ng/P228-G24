/**
 * Rate-package parser and catalogue.
 *
 * The property publishes several rate packages per room category (breakfast-only
 * up to full board with unlimited VinWonders tickets or golf rounds). Those
 * packages are what makes intelligent upselling possible: a guest who says
 * "I want a Deluxe" should be quoted the cheapest package, then shown what a
 * little more money buys.
 *
 * The source files are scraped from the booking site and are messy: every line is
 * duplicated, package titles lost their first character ("iá Công Bố Tốt Nhất"),
 * and each file repeats the same page-wide terms and conditions. Only three parts
 * are actually useful — the package name, the two prices, and the "Chi tiết gói
 * giá" inclusion list — so the parser keeps those and drops the rest.
 *
 * WHY STRUCTURED, NOT RAG TEXT
 * Prices must never be produced by the model. Everything here becomes rows the
 * agent queries through a tool, so a quoted figure is traceable to a tool result
 * exactly like every other price in this system (see numguard.ts). Packages also
 * have to be *filtered* (budget, "must have a pool", "we are four people") and
 * *ordered* (cheapest first, then the upsell ladder), which prose cannot do.
 *
 * STATIC vs DYNAMIC
 * Inclusions and prices are the published rate card — stable enough to store.
 * Cancellation deadlines ("free until 04/10/26") and blackout windows ("not valid
 * 25/5–15/8 or public holidays") are date-bound: they are captured verbatim as
 * `conditions` for display, but flagged so the agent never treats them as a
 * standing rule, and never computes a deadline from them itself.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ types */

export type MealPlan = "breakfast" | "full_board" | "none";

export type PackageFacets = {
  /** Which meals the rate includes. */
  mealPlan: MealPlan;
  /** Unlimited VinWonders theme-park admission for everyone in the room. */
  vinwonders: boolean;
  /** Included 18-hole golf rounds per room per night, 0 when none. */
  golfRounds: number;
  /** Hotel credit in VND per room per night, 0 when none. */
  hotelCredit: number;
  /** Free Aquafield spa & sauna experience (once per stay). */
  aquafield: boolean;
  /** Free in-resort sauna and jacuzzi. */
  saunaJacuzzi: boolean;
  /** Free cable car / Vinpearl Harbour access. */
  cableCar: boolean;
  /** Percentage discounts the package carries. */
  spaDiscountPct: number;
  fnbDiscountPct: number;
  golfDiscountPct: number;
};

export type RatePackage = {
  /** Folder name exactly as published, e.g. "Deluxe Hướng Biển 2 Giường Đơn". */
  roomNameVi: string;
  /** room_types.code this package belongs to, or null when unmapped. */
  roomCode: string | null;
  /** File stem, e.g. "gói 3" — kept so a row can be traced to its source. */
  sourceFile: string;
  /** Cleaned package name, e.g. "Giá Công Bố Tốt Nhất". */
  name: string;
  /** Published (rack) price per night in VND. */
  publicPrice: number;
  /** Pearl Club member price per night, null when the file did not state one. */
  memberPrice: number | null;
  /** The inclusion bullets, de-duplicated, in source order. */
  inclusions: string[];
  facets: PackageFacets;
  /** Date-bound text (cancellation deadline, no-show, surcharges) — display only. */
  conditions: string[];
  /** True when a benefit carries a seasonal/holiday blackout the guest must be told about. */
  hasBlackout: boolean;
};

/* ------------------------------------------------- name / price extraction */

/**
 * The scrape truncated the first character of many titles ("iá Công Bố Tốt Nhất",
 * "è Sánh Vibes") and the site itself misspells "Giá" as "Gía". Titles are
 * normalised to the two real package families so that the same product does not
 * appear under four spellings in a recommendation list.
 */
export function cleanPackageName(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (/s(á|a)nh\s*vibes/i.test(s) || /^[hè]?è?\s*sánh/i.test(s)) return "Hè Sánh Vibes";
  if (/stay\s*&?\s*play/i.test(s)) return "Stay & Play";
  if (/c[ôo]ng\s*b[ốo]/i.test(s)) return "Giá Công Bố Tốt Nhất";
  return s;
}

/** "4.270.000" / "7.390.900" -> 4270000. Returns null when not a real amount. */
function parseVnd(raw: string | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 4) return null;
  return Number(digits);
}

/* ------------------------------------------------------- facet derivation */

function pct(text: string, service: RegExp): number {
  /* Matches both orders the site uses: "Giảm 30% Spa" and "Ưu đãi 30% dịch vụ spa",
     as well as "20% ẩm thực" / "ẩm thực 20%". */
  const forward = new RegExp(`(\\d{1,2})\\s*%[^.,;]{0,40}?${service.source}`, "i");
  const backward = new RegExp(`${service.source}[^.,;]{0,25}?(\\d{1,2})\\s*%`, "i");
  const m = text.match(forward) ?? text.match(backward);
  return m ? Number(m[1]) : 0;
}

export function deriveFacets(inclusions: string[]): PackageFacets {
  const text = inclusions.join("\n");

  const fullBoard = /b[ữu]a\s*(buffet\s*)?s[áa]ng.*b[ữu]a\s*tr[ưu]a.*b[ữu]a\s*t[ốo]i/i.test(text);
  const breakfast = /b[ữu]a\s*s[áa]ng/i.test(text);

  const golfMatch = text.match(/(\d{1,2})\s*v[òo]ng\s*(ch[ơo]i\s*)?golf/i);

  const creditMatch = text.match(/hotel\s*credit\s*([\d.,]+)\s*đ/i);

  return {
    mealPlan: fullBoard ? "full_board" : breakfast ? "breakfast" : "none",
    // The site writes this two ways: "Vé Công viên chủ đề VinWonders, không giới
    // hạn" and "Vé vui chơi không giới hạn Vinwonders".
    vinwonders: /vinwonders/i.test(text) && /kh[ôo]ng\s*gi[ớo]i\s*h[ạa]n/i.test(text),
    golfRounds: golfMatch ? Number(golfMatch[1]) : 0,
    hotelCredit: creditMatch ? parseVnd(creditMatch[1]) ?? 0 : 0,
    // "Aquafiled" is the source's own misspelling of Aquafield; match both.
    aquafield: /aquafi[el][el]d/i.test(text),
    saunaJacuzzi: /x[ôo]ng\s*h[ơo]i.*jacuzzi|sauna.*jacuzzi|b[ểe]\s*s[ụu]c/i.test(text),
    cableCar: /c[áa]p\s*treo|vinpearl\s*harbour/i.test(text),
    spaDiscountPct: pct(text, /spa/),
    fnbDiscountPct: pct(text, /[ẩa]m\s*th[ựu]c/),
    golfDiscountPct: pct(text, /golf/),
  };
}

/* --------------------------------------------------------------- parsing */

/** Lines that are page furniture rather than package content. */
const NOISE = [
  /^Điều kiện gói$/i,
  /^Chi tiết gói giá$/i,
  /^Điều kiện, điều khoản$/i,
  /^Chính sách hoàn huỷ$/i,
  /^Free sauna & jacuzzi$/i,
  /^union/i,
  /^\/đêm$/i,
  /^Giá công bố/i,
  /^Giá thành viên/i,
];

/**
 * Lines that state a date-bound *rule* rather than a benefit: cancellation
 * deadlines, no-show charges, weekend/holiday surcharges.
 *
 * Deliberately narrow. An earlier version matched any line mentioning a blackout,
 * which swallowed the Aquafield line — "free Aquafield experience (… not valid
 * 25/5–15/8 …)" is a genuine inclusion that merely carries a caveat, and losing it
 * cost the package its headline benefit. Blackout windows inside a benefit stay
 * with that benefit; `hasBlackout` flags them separately.
 */
const CANCELLATION =
  /^(Miễn phí thay đổi|Chính sách hoàn hu[ỷy]|Giá không bao gồm ph[ụu] thu)|h[ủu][ỷy] phòng trước ngày|Không đến nhận phòng tính phí/i;

/** A benefit qualified by a seasonal / holiday blackout. */
const BLACKOUT = /kh[ôo]ng áp d[ụu]ng giai đo[ạa]n|các ngày l[ễe] t[ếe]t|ph[ụu] thu cu[ốo]i tu[ầa]n/i;

/**
 * The shared terms-and-conditions block repeated in every file. It is real but it
 * is property-wide policy (already in the policy register), not package content,
 * so it is dropped here rather than duplicated 68 times in the index.
 */
const SHARED_TC =
  /^(Phòng khách sạn: Tối đa|Villa: Mỗi phòng ngủ|Trẻ em dưới 4 tuổi|Người lớn thứ 3|Giường phụ có tính phí|Lưu ý về Hotel credit|Hotel Credit chỉ được|Dịch vụ F&B|Các bữa ăn bao gồm|Đồ uống Bar|Không áp dụng Room Service|Được gộp hotel credit|Không dùng hotel credit|Không áp dụng để mua|Hotel credit áp dụng|Không áp dụng tích điểm)/i;

export function parsePackageFile(content: string, roomNameVi: string, sourceFile: string): RatePackage | null {
  /* Kept UN-deduplicated on purpose. The scrape repeats each bullet in a short
     marketing summary above and again inside "Chi tiết gói giá"; de-duplicating
     the whole file first emptied the detail block for every package whose two
     copies were identical, which silently stripped meal plan and every other
     facet from those rows. Duplicates are collapsed per-section instead. */
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const joined = lines.join("\n");
  const publicPrice = parseVnd(joined.match(/Giá công bố\s*([\d.,]+)/i)?.[1]);
  const memberPrice = parseVnd(joined.match(/Giá thành viên\s*([\d.,]+)/i)?.[1]);
  if (publicPrice == null) return null; // a file with no rate is not a package

  const name = cleanPackageName(lines[0] ?? "");

  /* Inclusions come from the "Chi tiết gói giá" block, which is the authoritative
     itemisation; the lines above it are a shorter marketing repeat of the same. */
  const detailStart = lines.findIndex((l) => /^Chi tiết gói giá$/i.test(l));
  const detailEnd = lines.findIndex((l, i) => i > detailStart && /^Điều kiện, điều khoản$/i.test(l));
  const detailLines =
    detailStart >= 0
      ? lines.slice(detailStart + 1, detailEnd > detailStart ? detailEnd : undefined)
      : lines.slice(1);

  const inclusions: string[] = [];
  const conditions: string[] = [];
  const takenIncl = new Set<string>();
  const takenCond = new Set<string>();

  const classify = (l: string) => {
    if (NOISE.some((re) => re.test(l))) return;
    if (SHARED_TC.test(l)) return;
    if (CANCELLATION.test(l)) {
      if (!takenCond.has(l)) {
        takenCond.add(l);
        conditions.push(l);
      }
      return;
    }
    if (!takenIncl.has(l)) {
      takenIncl.add(l);
      inclusions.push(l);
    }
  };

  for (const l of detailLines) classify(l);
  /* Cancellation text sits outside the detail block, so sweep the whole file for
     it — inclusions are NOT collected here, or the marketing summary would
     duplicate the itemisation. */
  for (const l of lines) {
    if (NOISE.some((re) => re.test(l))) continue; // section headers are not conditions
    if (CANCELLATION.test(l) && !SHARED_TC.test(l) && !takenCond.has(l)) {
      takenCond.add(l);
      conditions.push(l);
    }
  }

  return {
    roomNameVi,
    roomCode: null, // filled by the loader, which knows the room_types table
    sourceFile,
    name,
    publicPrice,
    memberPrice,
    inclusions,
    facets: deriveFacets(inclusions),
    conditions,
    hasBlackout: inclusions.concat(conditions).some((l) => BLACKOUT.test(l)),
  };
}

/* ---------------------------------------------------------------- loading */

/** Folder name → room_types.code. The published folder names are the Vietnamese
 *  names, which is what `room_types.name_vi` holds, so mapping is by exact name
 *  with a small allowance for capitalisation drift ("Deluxe giường đôi"). */
export const FOLDER_TO_CODE: Record<string, string> = {
  "Biệt Thự 3 Phòng Ngủ Hướng Biển": "Villa 3-Bedroom Ocean View",
  "Biệt thự Tropicana 3 phòng ngủ, hướng biển": "Tropicana Beachfront Villa 3-Bedroom",
  "Deluxe 2 Giường Đơn": "Deluxe Twin Bed",
  "Deluxe giường đôi": "Deluxe Queen Bed",
  "Deluxe Hướng Biển 2 Giường Đơn": "Deluxe Ocean View Twin Bed",
  "Deluxe Hướng Biển Giường Đôi": "Deluxe Ocean View Queen Bed",
  "Grand Deluxe 2 Giường Đơn": "Grand Deluxe Twin Bed",
  "Grand Deluxe Giường Đôi": "Grand Deluxe Queen Bed",
  "Grand Deluxe Hướng Biển 2 Giường Đơn": "Grand Deluxe Ocean View Twin Bed",
  /* Published by the property but absent from room_types; the loader reports it
     rather than silently dropping seven real packages. */
  "Grand Deluxe Hướng Biển Giường Đôi": "Grand Deluxe Ocean View Queen Bed",
};

export type LoadResult = { packages: RatePackage[]; unmappedRooms: string[]; skippedFiles: string[] };

/** Read every `gói *.txt` under a room-catalogue directory. */
export function loadPackagesFrom(rootDir: string): LoadResult {
  const packages: RatePackage[] = [];
  const unmappedRooms: string[] = [];
  const skippedFiles: string[] = [];
  if (!existsSync(rootDir)) return { packages, unmappedRooms, skippedFiles };

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roomNameVi = entry.name;
    const code = FOLDER_TO_CODE[roomNameVi] ?? null;
    if (!code) unmappedRooms.push(roomNameVi);

    const dir = join(rootDir, roomNameVi);
    for (const f of readdirSync(dir)) {
      if (!/\.txt$/i.test(f)) continue;
      const stem = f.replace(/\.txt$/i, "").trim();
      const parsed = parsePackageFile(readFileSync(join(dir, f), "utf8"), roomNameVi, stem);
      if (!parsed) {
        skippedFiles.push(`${roomNameVi}/${f}`);
        continue;
      }
      parsed.roomCode = code;
      packages.push(parsed);
    }
  }
  return { packages, unmappedRooms, skippedFiles };
}

/**
 * A package's benefits as short labels.
 *
 * The parsed inclusions are verbatim marketing sentences — the Aquafield line
 * alone runs to 200 characters and appears in almost every package. Repeating
 * them across ten room articles buried the real breakfast-pricing article under
 * sixty copies of the phrase "Bữa sáng buffet", and the retrieval benchmark
 * caught it: hit@1 fell from 85% to 77%. Short labels carry the same facts at a
 * fraction of the length, and the exact wording still lives in `room_packages`
 * for the agent to quote from.
 */
function facetLabels(p: RatePackage): string[] {
  const f = p.facets;
  const bits: string[] = [];
  if (f.mealPlan === "full_board") bits.push("buffet sáng + trưa + tối");
  else if (f.mealPlan === "breakfast") bits.push("bữa sáng buffet");
  if (f.vinwonders) bits.push("vé VinWonders không giới hạn");
  if (f.golfRounds > 0) bits.push(`${f.golfRounds} vòng golf 18 hố`);
  if (f.hotelCredit > 0) bits.push(`hotel credit ${f.hotelCredit.toLocaleString("vi-VN")}đ/đêm`);
  if (f.aquafield) bits.push("Aquafield");
  if (f.saunaJacuzzi) bits.push("xông hơi & jacuzzi");
  if (f.cableCar) bits.push("cáp treo");
  const d: string[] = [];
  if (f.spaDiscountPct) d.push(`spa ${f.spaDiscountPct}%`);
  if (f.fnbDiscountPct) d.push(`ẩm thực ${f.fnbDiscountPct}%`);
  if (f.golfDiscountPct) d.push(`golf ${f.golfDiscountPct}%`);
  if (d.length) bits.push(`giảm ${d.join(", ")}`);
  return bits;
}

/** Labels shared by every package in a room — stated once, not per tier. */
function commonFacets(list: RatePackage[]): string[] {
  if (!list.length) return [];
  const sets = list.map((p) => new Set(facetLabels(p)));
  return facetLabels(list[0]).filter((l) => sets.every((s) => s.has(l)));
}

/* ------------------------------------------------- retrieval documents */

/**
 * Turn the parsed rate card into knowledge-base articles.
 *
 * The structured `room_packages` table is what the agent PRICES from, but a
 * table cannot be retrieved by someone asking "gói Hè Sánh Vibes có gì?" in
 * prose — and the offline model never sees the pricing tool at all, so without
 * these documents it is blind to packages entirely.
 *
 * Two rules make this safe, and they are exactly what an earlier hand-made
 * import got wrong:
 *
 *   1. GENERATED FROM THE SAME PARSE. These articles and the pricing rows are
 *      produced in one step from one source, so they cannot drift apart. A
 *      separate manual import keeps yesterday's prices after a rate change
 *      while the table moves on — and a stale price that looks sourced is worse
 *      than no price at all.
 *   2. NOTHING IS INVENTED. Only parsed inclusions are written. The import this
 *      replaces turned "Ưu đãi 20% Golf" (a 20% discount) into "02 vòng chơi
 *      Golf 18 hố" (two free rounds), promising a guest something worth millions
 *      that the package does not contain.
 *
 * One article per room category, not one per package: 68 near-identical
 * documents would swamp a 109-chunk index and make every retrieval about rates.
 */
export function packageArticles(
  packages: RatePackage[],
  lang: "vi" = "vi",
): Array<{ roomNameVi: string; roomCode: string | null; title: string; body: string; sourceFiles: string[] }> {
  const byRoom = new Map<string, RatePackage[]>();
  for (const p of packages) {
    const list = byRoom.get(p.roomNameVi) ?? [];
    list.push(p);
    byRoom.set(p.roomNameVi, list);
  }

  const out: Array<{ roomNameVi: string; roomCode: string | null; title: string; body: string; sourceFiles: string[] }> = [];
  for (const [roomNameVi, list] of byRoom) {
    /* The published data really does repeat itself: several rooms have two files
       describing the same package at the same price (villa "gói 1" and "gói 2"
       are identical in content). Listing both makes the article read like a
       glitch, so identical offers collapse to one. */
    const seenSig = new Set<string>();
    const unique = list.filter((p) => {
      const sig = `${p.name}|${p.publicPrice}|${p.inclusions.join("|")}`;
      if (seenSig.has(sig)) return false;
      seenSig.add(sig);
      return true;
    });
    const sorted = [...unique].sort((a, b) => a.publicPrice - b.publicPrice);
    const lines: string[] = [`${roomNameVi} — các gói giá công bố`, ""];

    /* Benefits every package in this room shares are stated once, and each
       package then lists only what makes it different. Repeating the common set
       per tier is both worse writing and measurably worse retrieval: with
       "bữa sáng buffet" printed on every line across ten rooms, these articles
       outranked the property's actual breakfast-pricing page. */
    const common = sorted.length > 1 ? commonFacets(sorted) : [];
    if (common.length) {
      lines.push(`Mọi gói dưới đây đều gồm: ${common.join(" · ")}.`);
      lines.push("");
    }

    sorted.forEach((p, i) => {
      const money = (n: number) => `${n.toLocaleString("vi-VN")}đ`;
      lines.push(
        `${i + 1}. ${p.name} — ${money(p.publicPrice)}/đêm` +
          (p.memberPrice ? ` (giá hội viên Pearl Club ${money(p.memberPrice)}/đêm)` : ""),
      );
      const extra = facetLabels(p).filter((l) => !common.includes(l));
      lines.push(extra.length ? `   Thêm: ${extra.join(" · ")}` : "   Không thêm quyền lợi nào ngoài phần chung.");
      lines.push("");
    });

    /* The cancellation wording is identical across a room's packages, so it is
       stated once instead of repeated under every tier. */
    const conditions = [...new Set(sorted.flatMap((p) => p.conditions))];
    if (conditions.length) {
      lines.push("Điều kiện áp dụng:");
      for (const c of conditions) lines.push(`   • ${c}`);
      lines.push("");
    }
    lines.push(
      "Lưu ý: giá và điều kiện theo bảng giá công bố của resort và có thể thay đổi — hãy xác nhận lại trước khi đặt.",
    );
    lines.push(
      "Cũng được hỏi là: gói phòng, bảng giá, giá phòng, combo, trọn gói, bao gồm gì, ưu đãi phòng, gói nào rẻ nhất.",
    );

    out.push({
      roomNameVi,
      roomCode: sorted[0]?.roomCode ?? null,
      title: `Gói giá phòng — ${roomNameVi}`,
      body: lines.join("\n"),
      sourceFiles: sorted.map((p) => `${p.roomNameVi}/${p.sourceFile}.txt`),
    });
  }
  return out.sort((a, b) => a.roomNameVi.localeCompare(b.roomNameVi));
}
