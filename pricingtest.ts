/**
 * Test suite for pricing, service catalogue, dining consistency, and early check-in.
 *
 * Runs standalone: node pricingtest.ts
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { DEFAULT_TRANSPORT } from "./server/ops";
import { priceService } from "./server/pricing";
import { quoteEarlyCheckin } from "./server/policy";
import type { Service } from "@shared/schema";

let failed = 0;

function pass(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failed++;
  }
}

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

const db = new Database(DB_PATH, { readonly: true });

console.log("=== Running pricingtest.ts ===\n");

/* ------------------------------------------------------------------ *
 * Test 1: Vé đưa đón sân bay giống nhau ở cả hai đường đọc
 * ------------------------------------------------------------------ */
const airportSvc = db
  .prepare("SELECT * FROM services WHERE category = 'transport' AND (name LIKE '%Cam Ranh Airport%' OR name LIKE '%Airport transfer%')")
  .get() as Service | undefined;

const opsAirportPrice = DEFAULT_TRANSPORT.services.find((s) => s.key === "airport_pickup")?.price;

pass(
  !!airportSvc && !!opsAirportPrice && airportSvc.price === opsAirportPrice,
  `Giá đưa đón sân bay đồng nhất giữa services DB (${airportSvc?.price} ₫) và DEFAULT_TRANSPORT ops (${opsAirportPrice} ₫)`
);

/* ------------------------------------------------------------------ *
 * Test 2: Món 0 ₫ không sinh ra giá âm hay giá giảm vô nghĩa
 * ------------------------------------------------------------------ */
const zeroSvc: Service = {
  id: 999,
  hotelId: 1,
  name: "À la carte dish zero price",
  category: "dining",
  description: "Test dish",
  price: 0,
  unit: "à la carte",
  dept: "fnb",
  active: 1,
  slots: "[]",
  capacityPerSlot: 10,
  images: "[]",
};

const pricedZeroGold = priceService(zeroSvc, "gold", 2, "VND");
const pricedZeroPlatinum = priceService(zeroSvc, "platinum", 2, "VND");

pass(
  pricedZeroGold.discount_pct === 0 &&
    pricedZeroGold.net_amount === 0 &&
    pricedZeroGold.saved === 0 &&
    !pricedZeroGold.calculation.includes("- 20%"),
  "Món 0 ₫ priced với hạng Gold không bị tính giảm giá 20% hay sinh ra giá âm (discount_pct = 0, net = 0)"
);

pass(
  pricedZeroPlatinum.discount_pct === 0 &&
    pricedZeroPlatinum.net_amount === 0 &&
    pricedZeroPlatinum.saved === 0,
  "Món 0 ₫ priced với hạng Platinum giữ nguyên discount_pct = 0"
);

/* ------------------------------------------------------------------ *
 * Test 3: Mọi tên nhà hàng mà services nhắc tới đều tồn tại trong dining_venues
 * ------------------------------------------------------------------ */
const diningServices = db
  .prepare("SELECT id, name FROM services WHERE category = 'dining' AND active = 1")
  .all() as { id: number; name: string }[];

const diningVenues = db
  .prepare("SELECT name_vi, code FROM dining_venues")
  .all() as { name_vi: string; code: string }[];

const venueNames = new Set<string>();
for (const v of diningVenues) {
  if (v.name_vi) venueNames.add(v.name_vi.toLowerCase());
  if (v.code) venueNames.add(v.code.toLowerCase());
}

let allVenuesExist = true;
const missingVenues: string[] = [];

for (const svc of diningServices) {
  // Trích xuất tên nhà hàng đứng trước dấu gạch ngang (ví dụ "Lotus Restaurant — dinner buffet")
  const parts = svc.name.split("—");
  const venuePart = parts[0].trim();
  
  // Bỏ qua các dịch vụ chung không gắn với 1 nhà hàng cố định như "Private beachfront dinner"
  if (venuePart.toLowerCase().includes("private beachfront")) continue;

  const match = Array.from(venueNames).some((vn) =>
    venuePart.toLowerCase().includes(vn) || vn.includes(venuePart.toLowerCase())
  );

  if (!match) {
    allVenuesExist = false;
    missingVenues.push(`${svc.name} (${venuePart})`);
  }
}

pass(
  allVenuesExist,
  allVenuesExist
    ? "Mọi tên nhà hàng trong services đều tồn tại trong dining_venues"
    : `Phát hiện dịch vụ nhắc tới nhà hàng không tồn tại trong dining_venues: ${missingVenues.join(", ")}`
);

/* ------------------------------------------------------------------ *
 * Test 4: Khách hạng có 2h miễn phí nhận phòng sớm phí thấp hơn hạng 0h
 * ------------------------------------------------------------------ */
const ratePerNight = 2_000_000;
const arrivalTime = "10:00"; // Trong khung 06:00 - 12:00

const quoteSilver = quoteEarlyCheckin({
  requestedTime: arrivalTime,
  ratePerNight,
  currency: "VND",
  standardCheckinTime: "14:00",
  vipTier: "silver", // 0 giờ free
});

const quotePlatinum = quoteEarlyCheckin({
  requestedTime: arrivalTime,
  ratePerNight,
  currency: "VND",
  standardCheckinTime: "14:00",
  vipTier: "platinum", // 2 giờ free
});

const silverFee = quoteSilver.fee ?? 0;
const platinumFee = quotePlatinum.fee ?? 0;
const diff = silverFee - platinumFee;
const expectedDiff = ratePerNight * 0.5; // 50% rate per night cho 2h từ 10:00-12:00

pass(
  platinumFee < silverFee && diff === expectedDiff,
  `Khách hạng Platinum (2h free) nhận phòng lúc 10:00 có phí (${platinumFee} ₫) thấp hơn hạng Silver 0h free (${silverFee} ₫), chênh lệch đúng bằng 2h được miễn (${diff} ₫)`
);

db.close();

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
