/**
 * Migration 010: stop the internal QA placeholder leaking into guest answers,
 * bridge room service to the real restaurant menus, and separate a staying
 * guest's own late return from the visitor curfew.
 *
 * THREE distinct problems, all found by tracing real guest questions on prod:
 *
 *   1. Five policies (ROOM_SERVICE, FACILITY_HOURS, LAUNDRY, TRANSPORT,
 *      LOYALTY_PROGRAM) carried the string "Giá trị mặc định do hệ thống tạo —
 *      ban quản lý cần xác nhận/cập nhật" in BOTH `summary` and `rules.note`.
 *      That is internal review metadata, not guest content — but it is in the
 *      indexed body, so the model read it and told a guest asking about room
 *      service that "the value is a system default the management must confirm".
 *      Replaced with a plain one-line description of what the policy IS. The
 *      actual figures live in `rules` and are untouched; only the meta-text is
 *      removed. (The `verified` column still records that these are unconfirmed,
 *      where that belongs — out of the guest-facing text.)
 *
 *   2. Room service had hours and a wait time but no dish list, so "đặt đồ ăn
 *      lên phòng món gì" dead-ended. It does not get an invented price list —
 *      the honest answer is that room-service dishes come from the resort's
 *      restaurants (whose real menus and prices are already indexed), ordered
 *      through reception. That bridge is added as `rules.note`.
 *
 * A THIRD change was tried and REVERTED: a `rules.guest_access` note on CONDUCT
 * stating a staying guest may return at any hour (to fix "về khuya 1 giờ sáng").
 * The behaviour golden caught it regressing — the 4B model treated the note as a
 * template and copied "khách được phép … bất kỳ lúc nào, kể cả sau nửa đêm" onto
 * unrelated questions, telling a guest that pets were allowed overnight (they are
 * banned) and answering a night-childcare question it should have deferred.
 * Fabrication rose 4→5/15. A permissive free-text note is a footgun for a small
 * model; the late-return case is better handled by the reranker surfacing the
 * right doc than by adding copyable permission text. Not re-added here.
 *
 * Idempotent: safe to run twice (each edit checks its own marker first). Edits
 * the DB and reindexes; it does not touch canonical-facts.json.
 *
 *   DB_FILE=data.db npx tsx server/migrations/010-clean-placeholders-and-bridge.ts
 */

import "dotenv/config";
import { migrate, storage } from "../storage";
import { reindex } from "../retrieval";

const PLACEHOLDER = "mặc định do hệ thống";

/** Plain, guest-appropriate one-line summaries. These describe what the policy
 *  is; they assert no specific figure (the figures stay in `rules`). */
const SUMMARIES: Record<string, string> = {
  ROOM_SERVICE:
    "Dịch vụ phục vụ đồ ăn tại phòng (room service): giờ phục vụ, thời gian chờ và cách đặt món.",
  FACILITY_HOURS:
    "Giờ mở cửa các tiện ích của resort: hồ bơi, phòng gym, spa, Kids Club, bãi biển, lễ tân và business center.",
  LAUNDRY:
    "Dịch vụ giặt ủi của resort: bảng giá theo loại đồ và thời gian giao đồ thường/hoả tốc.",
  TRANSPORT: "Dịch vụ di chuyển và đưa đón đến/đi từ resort.",
  LOYALTY_PROGRAM: "Chương trình khách hàng thân thiết Pearl Club: hạng thẻ và quyền lợi thành viên.",
};

const ROOM_SERVICE_NOTE =
  "Món ăn phục vụ tại phòng được lấy từ thực đơn các nhà hàng của resort (Lotus phục vụ cả ngày, cùng Jasmine, Ozone, Bách Giai…). " +
  "Quý khách gọi lễ tân (quay số 0 từ điện thoại trong phòng) để đặt món và biết danh sách món cùng giá hiện hành.";

function main() {
  migrate();
  let changed = 0;

  // 1 + 2: strip the placeholder from summary and rules.note of the five policies.
  for (const [code, summary] of Object.entries(SUMMARIES)) {
    const p = storage.getPolicy(code);
    if (!p) {
      console.log(`[skip] ${code} không tồn tại`);
      continue;
    }
    if (p.summary.includes(PLACEHOLDER)) {
      storage.updatePolicySummary(code, summary);
      changed++;
      console.log(`[summary] ${code} -> dọn placeholder`);
    }
    const rules = JSON.parse(p.rules || "{}");
    let rulesTouched = false;
    if (typeof rules.note === "string" && rules.note.includes(PLACEHOLDER)) {
      if (code === "ROOM_SERVICE") rules.note = ROOM_SERVICE_NOTE;
      else delete rules.note;
      rulesTouched = true;
    } else if (code === "ROOM_SERVICE" && rules.note !== ROOM_SERVICE_NOTE) {
      rules.note = ROOM_SERVICE_NOTE;
      rulesTouched = true;
    }
    if (rulesTouched) {
      storage.updatePolicyRules(code, JSON.stringify(rules));
      changed++;
      console.log(`[rules.note] ${code} -> ${code === "ROOM_SERVICE" ? "cầu nối menu" : "xoá placeholder"}`);
    }
  }

  // 3 (guest 24/7 access on CONDUCT) was reverted — see the header note. If an
  // earlier run of this migration added it, strip it back out so re-running
  // converges on the corrected state.
  const conduct = storage.getPolicy("CONDUCT");
  if (conduct) {
    const rules = JSON.parse(conduct.rules || "{}");
    if (rules.guest_access) {
      delete rules.guest_access;
      storage.updatePolicyRules("CONDUCT", JSON.stringify(rules));
      changed++;
      console.log(`[CONDUCT] gỡ guest_access (đã bị hồi quy)`);
    }
  }

  if (!changed) {
    console.log("Nothing to change — đã sạch từ trước.");
    return;
  }
  console.log(`\n${changed} thay đổi. Reindexing...`);
  reindex().then((r) =>
    console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})${r.embedError ? " — " + r.embedError : ""}`),
  );
}

main();
