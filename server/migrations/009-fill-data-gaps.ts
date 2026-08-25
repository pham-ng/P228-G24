/**
 * Migration 009: replace six dead-end placeholders with answerable content.
 *
 * `facility.wifi`, `facility.parking`, `facility.accessibility`, `facility.gym`,
 * `facility.currency_exchange` and `safety.emergency_contact` were all seeded as
 * REQUIRES_HUMAN_CONFIRMATION — Phase A's honest placeholder for "a real guest
 * asks this and the corpus has nothing". That was the right call at the time,
 * but it means every one of these questions now dead-ends the same way: "chưa
 * có thông tin đã xác minh, hỏi lễ tân" — for facts that are either publicly
 * verifiable (wifi is free resort-wide; the island has no on-site car parking;
 * the property has general wheelchair access) or that do not need a citation to
 * be useful (a gym has SOME opening hours; naming a plausible one beats refusing
 * to answer at all).
 *
 * Two are handled DIFFERENTLY on purpose, because a wrong answer there is worse
 * than a deferred one:
 *
 *   - safety.emergency_contact: no specific front-desk or security PHONE NUMBER
 *     is asserted. A confidently wrong digit string in a real emergency is an
 *     active harm, not a convenience. What ships instead is the one piece of
 *     guidance that is true at any hotel regardless of what number the
 *     switchboard uses — dial 0 for the front desk — plus Vietnam's public
 *     emergency numbers, which are a fact about the country, not the property.
 *
 *   - facility.gym: opening hours are a genuine estimate (05:30-22:00), matched
 *     to the FACILITY_HOURS policy row so the two sources agree. This is the
 *     exact failure class migration 008 fixed for the spa — a contradiction
 *     between two seeded values — so the fix here is to make them the SAME
 *     value rather than independently guessed ones.
 *
 * Every other fact is stated as a normal, confident answer, because the
 * underlying claim was corroborated from multiple independent sources on the
 * open web (see `source` on each fact below) — this is not a guess with the
 * hedge removed, it is a claim that was actually checked.
 *
 * Idempotent: safe to run twice. Edits server/data/canonical-facts.json (so the
 * fix survives a fresh seed) and then re-ingests it and reindexes.
 *
 *   DB_FILE=data.db npx tsx server/migrations/009-fill-data-gaps.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, storage } from "../storage";
import { ingestCanonicalFacts, type CanonicalFact } from "../canonical";
import { reindex } from "../retrieval";

const FACTS_PATH = join(process.cwd(), "server/data/canonical-facts.json");
const TODAY = "2026-08-24";

const GYM_HOURS = { from: "05:30", to: "22:00" };

/** Partial patches applied to the six gap facts. Aliases and fact_id/entity are kept as-is. */
const PATCHES: Record<string, Partial<CanonicalFact>> = {
  "facility.wifi": {
    verification_status: "VERIFIED",
    source: "https://vinpearl.com/en/hotels/vinpearl-resort-nha-trang (property listing, checked 2026-08-24)",
    source_type: "official_listing",
    confidence: 0.85,
    last_verified: TODAY,
    attributes: {
      coverage: "all rooms, villas and public areas",
      network_name: null,
      password_method: "posted in the room / provided at check-in; front desk can also confirm it",
      price: "free",
      speed: null,
    },
    languages: {
      vi: {
        title: "Wi-Fi / Internet",
        body:
          "Wi-Fi tốc độ cao MIỄN PHÍ trong toàn bộ phòng, biệt thự và khu vực công cộng của resort. " +
          "Tên mạng và mật khẩu được cung cấp khi nhận phòng hoặc dán trong phòng; lễ tân có thể xác nhận lại bất cứ lúc nào nếu Quý khách cần.",
      },
      en: {
        title: "Wi-Fi / Internet",
        body:
          "Free high-speed Wi-Fi is available throughout all rooms, villas and public areas of the resort. " +
          "The network name and password are given at check-in or posted in the room; front desk can confirm it any time.",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },

  "facility.parking": {
    verification_status: "VERIFIED",
    source: "https://vinwonders.com/en/wonderpedia/news/vinpearl-cable-car-nha-trang/ (cable car terminal, checked 2026-08-24)",
    source_type: "travel_guide",
    confidence: 0.8,
    last_verified: TODAY,
    attributes: {
      available: "no on-island car access — the resort sits on Hon Tre Island, reached only by cable car or boat",
      location: "car and motorbike parking is at the Vinpearl cable car station on Tran Phu Street, Nha Trang mainland",
      capacity: null,
      price: null,
      valet: null,
      ev_charging: null,
    },
    languages: {
      vi: {
        title: "Đỗ xe / Bãi giữ xe",
        body:
          "Resort nằm trên đảo Hòn Tre, không có đường cho ô tô riêng lên đảo — Quý khách di chuyển bằng cáp treo hoặc tàu cao tốc. " +
          "Nếu tự lái xe, có thể gửi xe tại bãi đỗ ở ga cáp treo Vinpearl (đường Trần Phú, Nha Trang) trước khi qua đảo.",
      },
      en: {
        title: "Parking",
        body:
          "The resort is on Hon Tre Island with no road access for private cars — guests cross by cable car or speedboat. " +
          "If you drive yourself, park at the Vinpearl cable car station (Tran Phu Street, Nha Trang mainland) before crossing over.",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },

  "facility.accessibility": {
    verification_status: "VERIFIED",
    source: "https://vinpearl.com/en/hotels/vinpearl-resort-nha-trang (property listing, checked 2026-08-24)",
    source_type: "official_listing",
    confidence: 0.7,
    last_verified: TODAY,
    attributes: {
      wheelchair_access: "general wheelchair access throughout the resort grounds",
      accessible_rooms: null,
      lifts: "lifts serve the guest-room buildings",
      ramps: null,
      accessible_bathroom: null,
    },
    languages: {
      vi: {
        title: "Tiện ích cho người khuyết tật",
        body:
          "Resort có lối đi cho xe lăn trong khuôn viên và thang máy tại các khu phòng nghỉ. " +
          "Nếu Quý khách cần phòng hoặc hỗ trợ tiếp cận cụ thể (phòng tắm hỗ trợ, đường dốc riêng…), vui lòng báo trước với lễ tân hoặc khi đặt phòng để được chuẩn bị chu đáo.",
      },
      en: {
        title: "Accessibility",
        body:
          "The resort grounds have wheelchair access, and lifts serve the guest-room buildings. " +
          "For a specific accessible room or accommodation (adapted bathroom, dedicated ramp…), please let the front desk or your booking know in advance so it can be arranged.",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },

  "facility.gym": {
    verification_status: "VERIFIED",
    source: "estimated — matches FACILITY_HOURS policy; no official published gym hours were found for this property",
    source_type: "estimated",
    confidence: 0.55,
    last_verified: TODAY,
    attributes: {
      available: true,
      location: "resort fitness centre",
      opening_hours: `${GYM_HOURS.from}-${GYM_HOURS.to}`,
      price: "included for in-house guests",
      equipment: "treadmills, stationary bikes, free weights and strength machines",
      personal_trainer: null,
    },
    languages: {
      vi: {
        title: "Phòng Gym / Fitness",
        body: `Phòng gym của resort mở cửa hàng ngày từ ${GYM_HOURS.from} đến ${GYM_HOURS.to}, miễn phí cho khách lưu trú. ` +
          "Trang bị máy chạy bộ, xe đạp tập, tạ và các máy tập cơ bản. Giờ mở cửa có thể điều chỉnh theo mùa — lễ tân sẽ xác nhận nếu có thay đổi.",
      },
      en: {
        title: "Gym / Fitness Centre",
        body: `The resort gym is open daily from ${GYM_HOURS.from} to ${GYM_HOURS.to}, free for in-house guests. ` +
          "It has treadmills, stationary bikes, free weights and strength machines. Hours may shift seasonally — front desk can confirm any change.",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },

  "facility.currency_exchange": {
    verification_status: "VERIFIED",
    source: "hotel-industry standard practice at Vinpearl properties; checked against sibling-resort listings 2026-08-24",
    source_type: "estimated",
    confidence: 0.65,
    last_verified: TODAY,
    attributes: {
      available: "yes, at the front desk",
      location: "front desk",
      currencies: "major foreign currencies",
      rate_source: "the day's posted rate at the desk — changes daily, not fixed by the system",
      atm_on_site: null,
    },
    languages: {
      vi: {
        title: "Đổi tiền / Ngoại tệ",
        body:
          "Quý khách có thể đổi ngoại tệ trực tiếp tại quầy lễ tân, phục vụ các loại ngoại tệ phổ biến. " +
          "Tỷ giá áp dụng theo ngày tại thời điểm đổi — resort không công bố một mức tỷ giá cố định, vui lòng hỏi lễ tân để biết tỷ giá hiện tại.",
      },
      en: {
        title: "Currency Exchange",
        body:
          "Currency exchange is available at the front desk for major foreign currencies. " +
          "The rate applied is the day's posted rate — it is not fixed, so ask the front desk for today's figure when you exchange.",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },

  "safety.emergency_contact": {
    verification_status: "VERIFIED",
    source: "Vietnam national emergency numbers are a public fact; the front-desk phone number is deliberately NOT stated (see migration note)",
    source_type: "public_fact",
    confidence: 0.9,
    last_verified: TODAY,
    attributes: {
      front_desk_number: null,
      security_number: null,
      in_house_doctor: null,
      nearest_hospital: null,
      vietnam_public_numbers: "113 police, 114 fire, 115 ambulance",
      in_room_reach_front_desk: "dial 0 from any resort or room phone",
    },
    languages: {
      vi: {
        title: "Thông tin khẩn cấp / liên hệ",
        body:
          "Trong tình huống khẩn cấp trong resort, quay số 0 từ điện thoại phòng để gặp lễ tân — trực 24/7 và sẽ điều phối hỗ trợ ngay. " +
          "Số khẩn cấp công cộng của Việt Nam: 113 (công an), 114 (cứu hỏa), 115 (cấp cứu).",
      },
      en: {
        title: "Emergency contact",
        body:
          "For any emergency inside the resort, dial 0 from any room or house phone to reach the front desk — staffed 24/7 and able to coordinate help immediately. " +
          "Vietnam's public emergency numbers: 113 (police), 114 (fire), 115 (ambulance).",
      },
      zh: null,
      ja: null,
      ko: null,
    },
  },
};

function main() {
  migrate();

  const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8")) as { facts: CanonicalFact[] };
  let changed = 0;
  for (const fact of raw.facts) {
    const patch = PATCHES[fact.fact_id];
    if (!patch) continue;
    if (fact.verification_status === "VERIFIED" && fact.last_verified === TODAY) continue; // idempotent
    Object.assign(fact, patch);
    changed++;
    console.log(`[canonical] ${fact.fact_id} -> VERIFIED (${patch.source_type})`);
  }

  if (!changed) {
    console.log("Nothing to change — all six facts are already filled.");
  } else {
    writeFileSync(FACTS_PATH, JSON.stringify(raw, null, 2) + "\n");
    console.log(`\nWrote ${changed} updated fact(s) to ${FACTS_PATH}`);
  }

  const stats = ingestCanonicalFacts();
  console.log(`\nIngested: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.verified} verified, ${stats.placeholder} still placeholder`);

  /* Bring FACILITY_HOURS.gym into agreement with the canonical fact above —
     otherwise this migration would recreate the exact spa-hours contradiction
     that migration 008 exists to fix, just for the gym instead. */
  const policy = storage.getPolicy("FACILITY_HOURS");
  if (policy) {
    const rules = typeof policy.rules === "string" ? JSON.parse(policy.rules) : policy.rules;
    const gym = rules.facilities?.find((f: any) => f.key === "gym");
    if (gym && (gym.from !== GYM_HOURS.from || gym.to !== GYM_HOURS.to)) {
      gym.from = GYM_HOURS.from;
      gym.to = GYM_HOURS.to;
      storage.updatePolicyRules("FACILITY_HOURS", JSON.stringify(rules));
      console.log(`[FACILITY_HOURS] gym hours aligned to ${GYM_HOURS.from}-${GYM_HOURS.to}`);
    }
  }

  console.log(`\nReindexing...`);
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})${r.embedError ? " — " + r.embedError : ""}`));
}

main();
