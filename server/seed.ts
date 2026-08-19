import { db, storage, migrate, sqlite } from "./storage";
import {
  hotels,
  staff,
  rooms,
  guests,
  reservations,
  folioCharges,
  conversations,
  messages,
  tasks,
  services,
  kbArticles,
  policies,
  offers,
  campaigns,
} from "@shared/schema";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/**
 * Property data below is taken from Vinpearl's own published pages and menus:
 *  - https://vinpearl.com/en/vinpearl-resort-nha-trang
 *  - https://vinpearl.com/vi/moi-nhat-bang-gia-phong-vinpearl-nha-trang  (room rates)
 *  - https://statics.vinwonders.com/AKOYA-VPLRNT%20-%20A4%20menu%20-%20Vietnamese_1636009386.pdf  (Akoya Spa menu)
 *  - https://vinpearl.com/vi/cap-nhat-gia-ve-cap-treo-vinpearl-nha-trang-moi-nhat  (cable car)
 *  - https://vinpearl.com/vi/lich-trinh-di-vinpearl-harbour-nha-trang  (Harbour combos)
 *  - https://vinwonders.com/en/wonderpedia/news/vinpearl-resort-nha-trang/  (rooms, F&B hours)
 * The policy register and the policy knowledge-base articles are transcribed from
 * Vinpearl's published terms:
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/dieu-khoan-chung
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-thanh-toan
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-giai-quyet-tranh-chap
 *  - https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-quyen-rieng-tu
 * Guests, reservations, conversations and operational history are synthetic —
 * a live PMS integration would replace them; everything else is the real property.
 */
export function seedIfEmpty() {
  migrate();
  const existing = db.select().from(hotels).limit(1).get();
  if (existing) return;

  /* ---------------- property ---------------- */
  db.insert(hotels)
    .values({
      name: "Vinpearl Resort Nha Trang",
      city: "Hon Tre Island, Nha Trang",
      timezone: "Asia/Ho_Chi_Minh",
      currency: "VND",
      checkInTime: "14:00",
      checkOutTime: "12:00",
      brandVoice:
        "Warm, hospitable and precise — the voice of a 476-key island resort on Hon Tre, Nha Trang, reached by cable car across the bay. Vietnamese warmth without flourish. Short sentences. Use the guest's name once, not repeatedly. Quote prices in Vietnamese dong. Never invent facilities, prices, schedules or policies: if it is not in the knowledge base or the service list, say you will confirm with the team.",
      slaMinutes: 10,
      aiEnabled: 1,
    })
    .run();

  /* ---------------- staff ---------------- */
  const staffRows = [
    { name: "Nguyễn Thị Lan", role: "manager", dept: "front_desk", pin: "1234" },
    { name: "Trần Quốc Bảo", role: "agent", dept: "front_desk", pin: "1234" },
    { name: "Phạm Thị Hoa", role: "agent", dept: "housekeeping", pin: "1234" },
    { name: "Lê Văn Thành", role: "agent", dept: "fnb", pin: "1234" },
    { name: "Đỗ Minh Khoa", role: "agent", dept: "engineering", pin: "1234" },
    { name: "Võ Thanh Trúc", role: "agent", dept: "spa", pin: "1234" },
  ];
  staffRows.forEach((s) => db.insert(staff).values({ ...s, active: 1 }).run());

  /* ---------------- rooms ----------------
   * Guest rooms sit on floors 1–5 of the resort blocks; the villas are
   * beachfront ground-level units. A live PMS would supply all 476 keys.
   */
  const roomTypes = [
    "Deluxe Queen Bed",
    "Deluxe Twin Bed",
    "Grand Deluxe Queen Bed",
    "Deluxe Ocean View Queen Bed",
    "Grand Deluxe Ocean View Twin Bed",
    "Deluxe Suite King Ocean View",
  ];
  for (let floor = 1; floor <= 5; floor++) {
    for (let n = 1; n <= 8; n++) {
      const number = `${floor}${n.toString().padStart(2, "0")}`;
      db.insert(rooms)
        .values({
          number,
          type: roomTypes[(floor + n) % roomTypes.length],
          floor,
          status: n === 3 ? "dirty" : n === 7 && floor === 4 ? "out_of_order" : "clean",
          housekeepingNote:
            floor === 4 && n === 7 ? "Aircon coil replacement — blocked until Friday" : null,
        })
        .run();
    }
  }
  [
    { number: "V01", type: "Villa 3-Bedroom Ocean View" },
    { number: "V02", type: "Villa 3-Bedroom Ocean View" },
    { number: "V03", type: "Tropicana Beachfront Villa 3-Bedroom" },
    { number: "V04", type: "Tropicana Beachfront Villa 3-Bedroom" },
  ].forEach((v) =>
    db.insert(rooms).values({ ...v, floor: 1, status: "clean", housekeepingNote: null }).run(),
  );

  const allRooms = storage.listRooms();

  /** Published nightly rates per category, in VND. */
  const RATES: Record<string, number> = {
    "Deluxe Queen Bed": 2_200_000,
    "Deluxe Twin Bed": 2_200_000,
    "Grand Deluxe Queen Bed": 2_410_000,
    "Deluxe Ocean View Queen Bed": 2_640_000,
    "Grand Deluxe Ocean View Twin Bed": 2_870_000,
    "Deluxe Suite King Ocean View": 4_097_000,
    "Villa 3-Bedroom Ocean View": 8_610_000,
    "Tropicana Beachfront Villa 3-Bedroom": 10_130_000,
  };
  const taken = new Set<number>();
  /** First free room of a category, so the folio rate always matches the key. */
  const pickRoom = (type: string) => {
    const room = allRooms.find(
      (r) => r.type === type && r.status === "clean" && !taken.has(r.id),
    );
    if (!room) throw new Error(`No free room of type ${type}`);
    taken.add(room.id);
    return room;
  };

  /* ---------------- guests + reservations ---------------- */
  const guestSeed = [
    {
      name: "Nguyễn Thanh Hà",
      phone: "+84912004455",
      email: "ha.nguyen@example.vn",
      lang: "vi",
      vipTier: "platinum",
      preferences: JSON.stringify(["Phòng yên tĩnh", "Ăn sáng kiểu Việt", "Trả phòng muộn"]),
      notes: "Khách doanh nghiệp quay lại thường xuyên, thường đặt Grand Deluxe Ocean View.",
      staysCount: 14,
      roomType: "Grand Deluxe Ocean View Twin Bed",
      code: "VPNT-2M77VD",
      checkIn: day(-1),
      checkOut: day(2),
      status: "in_house",
      source: "direct",
    },
    {
      name: "Trần Minh Quân",
      phone: "+84987112233",
      email: "quan.tran@example.vn",
      lang: "vi",
      vipTier: "none",
      preferences: JSON.stringify(["Hai giường đơn", "Ăn sáng sớm"]),
      notes: "Đi cùng hai con nhỏ (5 và 9 tuổi).",
      staysCount: 1,
      roomType: "Grand Deluxe Queen Bed",
      code: "VPNT-7H23PC",
      checkIn: day(0),
      checkOut: day(3),
      status: "in_house",
      source: "direct",
    },
    {
      name: "Kim Ji-woo",
      phone: "+821094220118",
      email: "jiwoo.kim@example.kr",
      lang: "ko",
      vipTier: "gold",
      preferences: JSON.stringify(["Aquafield sauna", "Late dinner", "High floor"]),
      notes: "Repeat guest from Seoul; books Aquafield on every stay.",
      staysCount: 4,
      roomType: "Deluxe Ocean View Queen Bed",
      code: "VPNT-5K18QA",
      checkIn: day(-2),
      checkOut: day(2),
      status: "in_house",
      source: "booking.com",
    },
    {
      name: "Ekaterina Sokolova",
      phone: "+79161002233",
      email: "e.sokolova@example.ru",
      lang: "ru",
      vipTier: "none",
      preferences: JSON.stringify(["Beachfront sunbeds", "Airport transfer"]),
      notes: null,
      staysCount: 1,
      roomType: "Deluxe Queen Bed",
      code: "VPNT-4Q18ZM",
      checkIn: day(0),
      checkOut: day(5),
      status: "in_house",
      source: "expedia",
    },
    {
      name: "Yuki Tanaka",
      phone: "+819044210087",
      email: "y.tanaka@example.jp",
      lang: "ja",
      vipTier: "silver",
      preferences: JSON.stringify(["Green tea in room", "Non-smoking"]),
      notes: "Honeymoon stay — arranged a private beachfront dinner.",
      staysCount: 2,
      roomType: "Deluxe Suite King Ocean View",
      code: "VPNT-9K52JH",
      checkIn: day(-3),
      checkOut: day(0),
      status: "in_house",
      source: "direct",
    },
    {
      name: "Lê Hoàng Phúc",
      phone: "+84903557788",
      email: "phuc.le@example.vn",
      lang: "vi",
      vipTier: "diamond",
      preferences: JSON.stringify(["Villa có hồ bơi riêng", "Xe điện đưa đón", "Golf"]),
      notes: "Gia đình 8 người, hai lần/năm. Chơi golf tại Vinpearl Golf Nha Trang.",
      staysCount: 21,
      roomType: "Tropicana Beachfront Villa 3-Bedroom",
      code: "VPNT-1D40TG",
      checkIn: day(-1),
      checkOut: day(3),
      status: "in_house",
      source: "direct",
    },
    {
      name: "Daniel Okafor",
      phone: "+2348031229087",
      email: "d.okafor@example.com",
      lang: "en",
      vipTier: "none",
      preferences: JSON.stringify(["Early gym", "Extra towels"]),
      notes: null,
      staysCount: 1,
      roomType: "Deluxe Twin Bed",
      code: "VPNT-5T09WB",
      checkIn: day(2),
      checkOut: day(5),
      status: "confirmed",
      source: "ai_agent",
    },
    {
      name: "Zhang Wei",
      phone: "+8613800138000",
      email: "zhang.wei@example.cn",
      lang: "zh",
      vipTier: "gold",
      preferences: JSON.stringify(["Chinese breakfast", "Bach Giai Restaurant"]),
      notes: "Đi công tác kết hợp nghỉ dưỡng; đã dùng phòng họp lần trước.",
      staysCount: 6,
      roomType: "Grand Deluxe Ocean View Twin Bed",
      code: "VPNT-6B44LN",
      checkIn: day(-5),
      checkOut: day(-1),
      status: "checked_out",
      source: "direct",
    },
  ];

  guestSeed.forEach((g) => {
    const room = pickRoom(g.roomType);
    const rate = RATES[g.roomType];
    const guest = db
      .insert(guests)
      .values({
        name: g.name,
        phone: g.phone,
        email: g.email,
        lang: g.lang,
        vipTier: g.vipTier,
        preferences: g.preferences,
        notes: g.notes,
        staysCount: g.staysCount,
      })
      .returning()
      .get();
    const res = db
      .insert(reservations)
      .values({
        hotelId: 1,
        guestId: guest.id,
        roomId: room.id,
        confirmationCode: g.code,
        checkIn: g.checkIn,
        checkOut: g.checkOut,
        checkOutTime: "12:00",
        adults: room.number.startsWith("V") ? 6 : 2,
        children: g.name === "Trần Minh Quân" ? 2 : room.number.startsWith("V") ? 2 : 0,
        ratePerNight: rate,
        status: g.status,
        source: g.source,
      })
      .returning()
      .get();
    const nights = Math.max(
      1,
      Math.round(
        (new Date(g.checkOut).getTime() - new Date(g.checkIn).getTime()) / 86_400_000,
      ),
    );
    db.insert(folioCharges)
      .values({
        reservationId: res.id,
        description: `Room ${room.number} (${room.type}) — ${nights} night(s) @ ${rate.toLocaleString("vi-VN")}`,
        amount: nights * rate,
        category: "room",
        createdAt: iso(nights * 1440),
      })
      .run();
    // Already-posted ancillary charges, using the property's published prices.
    const extras: Array<{ d: string; a: number; c: string }> =
      g.status === "in_house"
        ? [
            { d: "Lotus Restaurant — dinner buffet × 2", a: 1_300_000, c: "fnb" },
            { d: "Cable car round trip × 2", a: 400_000, c: "transport" },
          ]
        : g.status === "checked_out"
          ? [
              { d: "Akoya Spa — Balinese Massage 90'", a: 2_300_000, c: "spa" },
              { d: "VinWonders day ticket × 2", a: 2_100_000, c: "experience" },
              { d: "Minibar", a: 285_000, c: "minibar" },
            ]
          : [];
    extras.forEach((e, i) =>
      db
        .insert(folioCharges)
        .values({
          reservationId: res.id,
          description: e.d,
          amount: e.a,
          category: e.c,
          createdAt: iso(600 + i * 300),
        })
        .run(),
    );
  });

  /* ---------------- services (published prices in VND) ---------------- */
  const svc = [
    /* --- dining --- */
    {
      name: "Lotus Restaurant — dinner buffet",
      category: "dining",
      description:
        "Traditional Vietnamese buffet in the Executive building. Dinner service 18:00–22:00. Adults and teens 650,000; children 11 and under 375,000.",
      price: 650_000,
      unit: "per adult",
      dept: "fnb",
      slots: JSON.stringify(["18:00", "18:30", "19:00", "19:30", "20:00"]),
      capacityPerSlot: 20,
    },
    {
      name: "Lotus Restaurant — lunch buffet",
      category: "dining",
      description: "Vietnamese buffet lunch, 12:00–14:30, Executive building.",
      price: 650_000,
      unit: "per adult",
      dept: "fnb",
      slots: JSON.stringify(["12:00", "12:30", "13:00"]),
      capacityPerSlot: 20,
    },
    {
      name: "Jasmine Restaurant — à la carte dinner",
      category: "dining",
      description:
        "250-seat à la carte restaurant on the ground floor of the Executive building, European and international dishes alongside Vietnamese, Thai and Cambodian plates, with views over Nha Trang bay. Open 11:00–22:00; charged per the à la carte menu.",
      price: 0,
      unit: "à la carte",
      dept: "fnb",
      slots: JSON.stringify(["18:00", "19:00", "20:00", "21:00"]),
      capacityPerSlot: 12,
    },
    {
      name: "Groove & Grill — Saturday beach BBQ",
      category: "dining",
      description:
        "Saturdays 18:30–22:00 at Jasmine: welcome cocktail, BBQ seafood including lobster and oysters, unlimited beer, soft drinks and juice, plus a live band. Price confirmed by F&B at booking.",
      price: 0,
      unit: "per person",
      dept: "fnb",
      slots: JSON.stringify(["18:30", "19:00", "19:30"]),
      capacityPerSlot: 15,
    },
    {
      name: "Ozone Restaurant — seafood (Imperial Club)",
      category: "dining",
      description:
        "Seafood restaurant at the Imperial Club serving 17 signature sauces. Open 10:30–14:30 and 17:30–22:00.",
      price: 0,
      unit: "à la carte",
      dept: "fnb",
      slots: JSON.stringify(["11:00", "12:00", "18:00", "19:00", "20:00"]),
      capacityPerSlot: 10,
    },
    {
      name: "Bach Giai Restaurant — Chinese (Imperial Club)",
      category: "dining",
      description:
        "Cantonese and Chinese cuisine in a royal-palace setting at the Imperial Club. Open 10:30–20:00.",
      price: 0,
      unit: "à la carte",
      dept: "fnb",
      slots: JSON.stringify(["11:00", "12:00", "17:30", "18:30"]),
      capacityPerSlot: 10,
    },
    {
      name: "Private beachfront dinner",
      category: "dining",
      description:
        "A private table set on the resort's 1.1 km white-sand beach, arranged through reception. Menu and price confirmed by F&B.",
      price: 0,
      unit: "per couple",
      dept: "fnb",
      slots: JSON.stringify(["18:00", "19:00", "20:00"]),
      capacityPerSlot: 2,
    },

    /* --- Akoya Spa, published menu prices (incl. tax & service charge) --- */
    {
      name: "Akoya Spa — Warm Bamboo Massage 85'",
      category: "spa",
      description:
        "Warm bamboo rolled along the muscles to release deep tension. 1 hour 25 minutes. Prices include tax and service charge.",
      price: 2_700_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:30", "11:00", "14:00", "16:00", "18:00", "20:00"]),
      capacityPerSlot: 2,
    },
    {
      name: "Akoya Spa — Hot Stone Therapy 90'",
      category: "spa",
      description: "Heated basalt stones with warm oil for circulation and deep relaxation. 1 hour 30 minutes.",
      price: 2_500_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["10:00", "12:00", "15:00", "17:00", "19:00"]),
      capacityPerSlot: 2,
    },
    {
      name: "Akoya Spa — Balinese Massage 90'",
      category: "spa",
      description: "Classic Balinese technique with long strokes and acupressure. 1 hour 30 minutes (60 minutes: 1,600,000).",
      price: 2_300_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:00", "11:30", "13:30", "16:30", "18:30", "20:30"]),
      capacityPerSlot: 3,
    },
    {
      name: "Akoya Spa — Vietnamese Traditional Massage 60'",
      category: "spa",
      description: "Traditional Vietnamese pressure-point massage. 1 hour (90 minutes: 2,300,000).",
      price: 1_500_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:00", "10:30", "13:00", "15:00", "17:30", "19:30", "21:00"]),
      capacityPerSlot: 3,
    },
    {
      name: "Akoya Spa — Foot Therapy 50'",
      category: "spa",
      description: "Reflexology-based foot and lower-leg therapy after a day on the island. 50 minutes.",
      price: 1_200_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "21:00"]),
      capacityPerSlot: 4,
    },
    {
      name: "Akoya Spa — Spa Sampler 90'",
      category: "spa",
      description: "Foot ritual, back massage and express facial in one 1 hour 30 minute session.",
      price: 2_000_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:30", "11:30", "14:30", "16:30", "19:00"]),
      capacityPerSlot: 2,
    },
    {
      name: "Akoya Spa — Thalgo Collagen Radiance facial 60'",
      category: "spa",
      description: "Thalgo marine collagen facial for firmness and radiance. 1 hour.",
      price: 2_200_000,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["10:00", "13:00", "15:30", "18:00", "20:00"]),
      capacityPerSlot: 2,
    },

    /* --- experiences & transport --- */
    {
      name: "Vinpearl cable car — round trip",
      category: "transport",
      description:
        "The 2,642.8 m cable car across the bay between Vinpearl Harbour and Hon Tre Island; roughly 8–12 minutes, 8 guests per cabin, running about 08:00–22:00. Khanh Hoa residents 100,000.",
      price: 200_000,
      unit: "per person",
      dept: "front_desk",
      slots: JSON.stringify(["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"]),
      capacityPerSlot: 24,
    },
    {
      name: "VinWonders Nha Trang — day ticket",
      category: "experience",
      description:
        "Full-day VinWonders ticket including the round-trip cable car. Adults 1,050,000; children 1 m–1.4 m and guests 60+ 800,000; under 1 m free. After-16:00 ticket 700,000 / 550,000.",
      price: 1_050_000,
      unit: "per adult",
      dept: "front_desk",
      slots: JSON.stringify(["09:00", "11:00", "13:00", "16:00"]),
      capacityPerSlot: 30,
    },
    {
      name: "VinWonders — 2-day unlimited pass",
      category: "experience",
      description: "Two consecutive days of unlimited VinWonders entry (3-day pass 1,400,000).",
      price: 1_280_000,
      unit: "per person",
      dept: "front_desk",
      slots: JSON.stringify(["09:00", "11:00"]),
      capacityPerSlot: 20,
    },
    {
      name: "Vinpearl Harbour — all-inclusive combo",
      category: "experience",
      description:
        "Harbour combo including the water-music show, Tata Show and 2 hours at Aquafield Nha Trang. The basic Harbour combo is 200,000.",
      price: 400_000,
      unit: "per person",
      dept: "front_desk",
      slots: JSON.stringify(["16:00", "17:30", "19:00"]),
      capacityPerSlot: 20,
    },
    {
      name: "Electric buggy transfer",
      category: "transport",
      description:
        "Complimentary electric buggy between the pier, the cable-car station and the resort buildings. Call reception and one is sent.",
      price: 0,
      unit: "complimentary",
      dept: "front_desk",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "Cam Ranh Airport transfer",
      category: "transport",
      description:
        "Private car from Cam Ranh International Airport to Cau Da Port, 45–60 minutes, then cable car or speedboat to the island. Price quoted by concierge on confirmation.",
      price: 0,
      unit: "per vehicle",
      dept: "front_desk",
      slots: JSON.stringify([
        "05:00",
        "07:00",
        "09:00",
        "11:00",
        "13:00",
        "15:00",
        "17:00",
        "19:00",
        "21:00",
      ]),
      capacityPerSlot: 4,
    },
    {
      name: "Beach & water sports desk",
      category: "experience",
      description:
        "Kayaking, beach volleyball, parasailing, jet ski, swimming and cycling on the resort's 1.1 km private beach. Equipment prices are quoted at the beach desk.",
      price: 0,
      unit: "on request",
      dept: "front_desk",
      slots: JSON.stringify(["08:00", "10:00", "14:00", "16:00"]),
      capacityPerSlot: 10,
    },
    {
      name: "Aquafield Nha Trang — Korean sauna",
      category: "experience",
      description:
        "Korean-style sauna open 09:00–22:00 with 7 therapy rooms: Snow, Cypress Wood, Mist, Salt Stone, Bulgama, Charcoal and Yellow Earth. Entry included in the Harbour all-inclusive combo; standalone price confirmed at booking.",
      price: 0,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:00", "11:00", "14:00", "16:00", "19:00"]),
      capacityPerSlot: 12,
    },

    /* --- in-room dining ---
     * The resort does not publish its in-room dining menu online, so these
     * prices are indicative and confirmed by F&B when the order is taken.
     */
    {
      name: "In-room dining — Phở bò",
      category: "roomservice",
      description: "Beef pho with brisket, herbs and chilli. Indicative price, confirmed by F&B.",
      price: 250_000,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Bún cá Nha Trang",
      category: "roomservice",
      description: "Local Nha Trang fish-cake noodle soup. Indicative price, confirmed by F&B.",
      price: 250_000,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Club sandwich & fries",
      category: "roomservice",
      description: "Chicken, bacon and fries. Indicative price, confirmed by F&B.",
      price: 320_000,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Vietnamese breakfast set",
      category: "roomservice",
      description:
        "Xôi, bánh cuốn, fresh fruit and cà phê sữa đá. Indicative price, confirmed by F&B.",
      price: 350_000,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — fresh coconut",
      category: "roomservice",
      description: "Chilled young coconut delivered to the room. Indicative price, confirmed by F&B.",
      price: 90_000,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
  ];
  svc.forEach((s) => db.insert(services).values({ ...s, active: 1 }).run());

  /* ---------------- knowledge base (from official Vinpearl sources) ---- */
  const kb = [
    {
      category: "policy",
      title: "Check-in, check-out and identification",
      body: "Check-in follows the standard time and check-out must be no later than 12:00. Guests present an ID card or passport at check-in; children travelling with the family need a birth certificate, and a photograph is taken for the face-recognition check-in with the guest's consent. Early check-in must be confirmed in advance and is never granted before 12:00 without a charge: arrival before 06:00 is charged 100% of the package price and arrival between 06:00 and 12:00 is charged 50%, payable as soon as the early arrival is confirmed. Late departure is subject to availability and is charged 50% of the package price between 12:00 and 18:00 and 100% after 18:00. Charges are calculated on Vinpearl's published rate (Gia Cong Bo), or on the contract rate when a partner settles the bill. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong",
      tags: ["checkin", "checkout", "late checkout", "early checkin", "id", "passport", "face recognition", "fee"],
    },
    {
      category: "wayfinding",
      title: "Getting to the resort from Cam Ranh Airport",
      body: "Cam Ranh International Airport to Cau Da Port takes 45–60 minutes by car. From Cau Da / Vinpearl Harbour you cross to Hon Tre Island either by cable car or by speedboat. The cable car is 2,642.8 m long, takes roughly 8–12 minutes, carries 8 guests per cabin and runs from about 08:00 to 22:00; the last speedboat back to the mainland leaves around 23:15. A complimentary electric buggy runs between the pier, the cable-car station and the resort buildings — call reception. Vinpearl and VinWonders guests also have a free round-trip VinBus. Source: https://vinpearl.com/vi/lich-trinh-di-vinpearl-harbour-nha-trang",
      tags: ["airport", "cam ranh", "cable car", "speedboat", "buggy", "transfer", "vinbus"],
    },
    {
      category: "neighborhood",
      title: "Cable car and Vinpearl Harbour ticket prices",
      body: "The cable car runs from about 08:00 to 22:00 and takes 8–12 minutes each way. A standalone round-trip cable car ticket is 200,000 VND per person; Khanh Hoa residents pay 100,000. The Vinpearl Harbour combo is 200,000 VND, and the all-inclusive combo at 400,000 VND adds the water-music show, the Tata Show and 2 hours at Aquafield Nha Trang. Vinpearl Harbour is open 08:00–24:00, with the Cabaret Show at 16:00–17:00 and the Street Circus at 17:30–18:30. Source: https://vinpearl.com/vi/cap-nhat-gia-ve-cap-treo-vinpearl-nha-trang-moi-nhat",
      tags: ["cable car", "ticket", "price", "hours", "harbour", "combo", "aquafield"],
    },
    {
      category: "neighborhood",
      title: "VinWonders Nha Trang tickets and shows",
      body: "The standard VinWonders ticket includes the round-trip cable car: 1,050,000 VND for adults, 800,000 for children 1 m–1.4 m and guests aged 60 and over, free for children under 1 m. An after-16:00 ticket is 700,000 / 550,000. Multi-day passes are 1,280,000 for 2 days and 1,400,000 for 3 days of unlimited entry. Highlights include the Sky Wheel, the 880 m zipline and the Tata Show; the water-music show and Tata Show run 19:00–20:00, and the Stunt Show at Vinpearl Harbour is 21:30–21:50. Source: https://vinwonders.com/en/wonderpedia/news/vinpearl-resort-nha-trang/",
      tags: ["vinwonders", "ticket", "price", "show", "tata", "zipline", "sky wheel", "children"],
    },
    {
      category: "dining",
      title: "Restaurants and bars — hours",
      body: "Lotus Restaurant (Executive building) serves the traditional Vietnamese buffet 06:00–10:30, 12:00–14:30 and 18:00–22:00. Jasmine Restaurant, 250 seats on the ground floor of the Executive building, serves à la carte European, international, Vietnamese, Thai and Cambodian dishes 11:00–22:00 with bay views. Orchid Restaurant offers an international buffet. Beach Comber Bar is open 09:00–23:00 for tropical cocktails at sunset, Seaview Lounge 07:00–23:00 for cocktails, wine and light bites, and the Pool Bar 09:00–18:00. At the Imperial Club, Ozone Restaurant serves seafood with 17 signature sauces 10:30–14:30 and 17:30–22:00, and Bach Giai Restaurant serves Chinese cuisine 10:30–20:00. On Saturdays, Groove & Grill runs 18:30–22:00 at Jasmine with a welcome cocktail, BBQ seafood including lobster and oysters, unlimited beer, soft drinks and juice, and a live band. Restaurant reservations: 0258 359 8900.",
      tags: ["restaurant", "bar", "hours", "lotus", "jasmine", "ozone", "bach giai", "bbq", "dinner"],
    },
    {
      category: "dining",
      title: "Breakfast and buffet pricing",
      body: "Breakfast is served at Lotus Restaurant from 06:00 to 10:30. The buffet is 650,000 VND for adults and for children aged 12–17, and 375,000 VND for children 11 and under. Two children under 12 eat breakfast free when staying with a Pearl Club member. Additional restaurants inside VinWonders include the Coral Buffet, the Vietnamese Restaurant, Yummy Water World, Wind & Sea and Tata Coffee.",
      tags: ["breakfast", "buffet", "price", "children", "lotus", "hours"],
    },
    {
      category: "property",
      title: "Akoya Spa — treatments and prices",
      body: "Akoya Spa on Hon Tre Island is open 09:00–22:00 and all prices include tax and service charge. Massages: Warm Bamboo 1h25 2,700,000; Hot Stone Therapy 1h30 2,500,000; Balinese 1h30 2,300,000 or 1h 1,600,000; Vietnamese Traditional 1h30 2,300,000 or 1h 1,500,000; Four Hands 1h 2,000,000; Shiatsu 1h 1,800,000; Foot Therapy 50' 1,200,000; Express Massage 30' 900,000. Packages: Harmony 2h 2,900,000; Deep Cleansing Facial 1h55 2,800,000; Recovery 1h50 2,700,000; Spa Sampler 1h30 2,000,000. Thalgo facials: collagen radiance 1h 2,200,000; rejuvenating 1h15 2,200,000; purity 1h15 1,700,000; cold cream 1h15 1,700,000; relaxing body scrub 1h 1,700,000; Pure Nature facial 50' 1,500,000. Hair wash and blow dry 1h 500,000. Source: https://statics.vinwonders.com/AKOYA-VPLRNT%20-%20A4%20menu%20-%20Vietnamese_1636009386.pdf",
      tags: ["spa", "akoya", "massage", "facial", "price", "hours", "wellness"],
    },
    {
      category: "property",
      title: "Beach, pool and water sports",
      body: "The resort has a 1.1 km private white-sand beach and a main swimming pool surrounded by tropical greenery. Beach activities include kayaking, beach volleyball, parasailing, jet ski, swimming and cycling; equipment prices are quoted at the beach desk. Private beachfront dinners can be arranged through reception. Ocean Home offers coral diving nearby, and Vinpearl Submarine — the world's first fully transparent acrylic tourist submarine — operates from the island.",
      tags: ["beach", "pool", "kayak", "jet ski", "parasailing", "swimming", "submarine", "diving"],
    },
    {
      category: "property",
      title: "Rooms and room types",
      body: "The resort has 476 rooms on floors 1–5, all with telephone, high-speed internet, TV, air conditioning, hairdryer and minibar; Grand Deluxe categories have a balcony. Deluxe Queen and Deluxe Twin are 32 m² with garden view, maximum 4 guests, from 2,200,000 VND per night. Grand Deluxe Queen and Twin are 42 m² garden view, from 2,410,000. Deluxe Ocean View is 32 m² from 2,640,000, and Grand Deluxe Ocean View 42 m² from 2,870,000. Deluxe Suite King Ocean View is 52 m², around 4,097,000. The 3-Bedroom Ocean View Villa is 370 m² with a private pool for up to 12 guests, from 8,610,000, and the Tropicana Beachfront Villa 3-Bedroom is 370 m² with a private pool and tropical garden, from 10,130,000. Source: https://vinpearl.com/vi/moi-nhat-bang-gia-phong-vinpearl-nha-trang",
      tags: ["room", "type", "price", "villa", "ocean view", "size", "amenities"],
    },
    {
      category: "property",
      title: "Aquafield Nha Trang — Korean sauna",
      body: "Aquafield Nha Trang is a Korean-style sauna and bathing complex open 09:00–22:00 with 7 therapy rooms: Snow, Cypress Wood, Mist, Salt Stone, Bulgama, Charcoal and Yellow Earth. Two hours of Aquafield are included in the Vinpearl Harbour all-inclusive combo (400,000 VND), and Pearl Club members receive a complimentary ticket.",
      tags: ["aquafield", "sauna", "korean", "spa", "hours", "therapy"],
    },
    {
      category: "property",
      title: "Meetings and events (MICE)",
      body: "The resort has a 660 m² grand ballroom seating up to 600 guests plus 7 additional conference rooms, with the island setting used for incentive programmes and gala dinners. Event enquiries go through the front desk, which coordinates with the MICE team on layout, catering and cable-car or speedboat transfers for delegates.",
      tags: ["mice", "meeting", "conference", "ballroom", "event", "wedding", "gala"],
    },
    {
      category: "neighborhood",
      title: "Entertainment and golf on Hon Tre",
      body: "On the island: VinWonders Nha Trang with the Sky Wheel, an 880 m zipline and the Tata Show; the Imperial Club with Chinese and seafood dining, a disco, bowling and karaoke; Vinpearl Golf Nha Trang, an 18-hole course designed with IMG Worldwide; Ocean Home for coral diving; and Vinpearl Submarine. Vinpearl Harbour on the mainland side is open 08:00–24:00. Pearl Club members receive 33% off golf and 30% off spa.",
      tags: ["golf", "vinwonders", "imperial club", "bowling", "karaoke", "entertainment", "show"],
    },
    {
      category: "policy",
      title: "Pearl Club member benefits",
      body: "Room discounts are 5% for Member and Gold, 7% for Platinum and 10% for Diamond, with up to 2% back in V-Point. Members receive 33% off golf, 30% off spa and 20% off food and beverage excluding alcohol, complimentary early check-in up to 2 hours and late check-out up to 2 hours subject to availability, a complimentary Aquafield ticket, and free breakfast for two children under 12. Stays of 2 nights or more earn 300,000 VND hotel credit per room per night, and stays of 3 nights or more include an unlimited VinWonders day pass for two guests.",
      tags: ["loyalty", "member", "pearl club", "discount", "benefit", "credit", "vpoint"],
    },
    {
      category: "policy",
      title: "Families and children",
      body: "Children travelling with the family need a birth certificate at check-in. The buffet is 375,000 VND for children 11 and under, and two children under 12 eat breakfast free when staying with a Pearl Club member. VinWonders entry is free for children under 1 m and 800,000 VND for children 1 m–1.4 m. The private beach, main pool and VinWonders water park are the usual family plan; the beach desk can supply kayaks and bicycles.",
      tags: ["children", "kids", "family", "baby", "birth certificate", "price"],
    },
    {
      category: "wayfinding",
      title: "Contacting the resort and on-site navigation",
      body: "Resort hotline +84 258 359 8222; restaurant reservations and bookings 0258 359 8900. The address is Hon Tre Island, Vinh Nguyen Ward, Nha Trang City, Khanh Hoa. Reception, Lotus and Jasmine are in the Executive building; Ozone and Bach Giai are at the Imperial Club; Akoya Spa, the main pool and the private beach are a short buggy ride away. Ask reception for a complimentary buggy rather than walking between zones in the midday heat.",
      tags: ["contact", "phone", "address", "reception", "directions", "map", "buggy"],
    },

    /* ---- policy articles, transcribed from booking.vinpearl.com terms ---- */
    {
      category: "policy",
      title: "Occupancy limits, extra beds and children",
      body: "A hotel room takes a maximum of 4 people including children under 4 — either 3 adults and 1 child, or 2 adults and 2 children. At most one extra bed can be added per room and availability depends on the individual hotel. Children aged 4 to under 12 and everyone aged 12 and over are charged a surcharge. In a villa the limit is 2 adults plus 2 children under 12 per bedroom, and extra beds are not available in villas other than Vinpearl Luxury Nha Trang. The package price assumes 2 adults per room, or 2 adults per villa bedroom. When there is no birth certificate to prove age, height decides: under 1 m counts as under 4, 1 m to 1.4 m counts as 4 to under 12, and above 1.4 m counts as 12 and over. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong",
      tags: ["occupancy", "extra bed", "children", "child", "family", "villa", "surcharge", "height", "age", "max guests"],
    },
    {
      category: "policy",
      title: "Check-in deposit",
      body: "A deposit is collected at check-in: 1,000,000 VND per room and 3,000,000 VND per villa. It is returned in full at check-out provided there are no unpaid charges and nothing in the room has been damaged or is missing. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong",
      tags: ["deposit", "guarantee", "refund", "checkin", "villa", "damage"],
    },
    {
      category: "policy",
      title: "Guest list deadlines and name changes",
      body: "For individual bookings the guest list must be sent 7 days before arrival in low season, 15 days in high season, and at the moment of booking in peak season and during Tet. Flight details for an airport transfer are needed at least 5 days ahead, and a transfer can only be changed or cancelled at least 72 hours before the pick-up. Changing a guest's identity after the deadline costs 350,000 VND per room per change; the fee is waived on proof of illness or a natural disaster. A request to change a full-board meal must reach the hotel at least 5 days ahead and is only possible for check-in before 13:00. On the free shuttle, be in the lobby 15 minutes before departure — the bus leaves on time without waiting. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong",
      tags: ["guest list", "name change", "deadline", "transfer", "flight", "shuttle", "meal", "full board", "fee"],
    },
    {
      category: "policy",
      title: "Package codes and booking classes",
      body: "Package codes: RO room only, BB bed and breakfast, HB half board, FB full board, and the villa and BBQ variants ROV, BBV, BBVS, BBW, FBV, FBVS, FBW, FBSFD, FVSFD, FXSFD, FWSFD, FBBQD, FVBQD, FXBQD, FWBQD, plus G1P and G2P for 18 holes of golf for one or two players. An individual booking (Khach Le) is up to 9 rooms or 4 villas per night; from 10 rooms or 5 villas it is a group booking, and three or more groups on the same itinerary form a series. The full package price is payable for the whole registered stay even if the guest leaves early. A voucher must be presented and surrendered at check-in, otherwise the published rate is charged. In exceptional cases such as force majeure or renovation Vinpearl may move guests to an equivalent room or hotel. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/dieu-khoan-chung",
      tags: ["package", "code", "rate plan", "group", "voucher", "early departure", "relocation", "terms"],
    },
    {
      category: "policy",
      title: "House rules — smoking, pets and outside food",
      body: "Pets are not allowed anywhere on the property. Smoking is only permitted in the signed smoking areas; smoking elsewhere costs 3,000,000 VND per stay. Bringing food or drink in from outside must be declared and carries a service fee of 1,175,000 VND per occasion, with a liability waiver to sign. Durian, jackfruit and other strongly scented food may not be taken into the rooms, and weapons, chemicals and explosives are prohibited. A villa kitchen is for reheating only; a barbecue must be registered with the Customer Service Centre and a fee applies. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung",
      tags: ["smoking", "fine", "pets", "outside food", "durian", "bbq", "villa kitchen", "prohibited", "house rules"],
    },
    {
      category: "policy",
      title: "House rules — visitors, pool, sea and noise",
      body: "A visitor leaves an identity document at reception, and no visitors are allowed in the rooms after 20:00; anyone staying overnight must be registered and paid for. The swimming pool closes at 22:00 at the latest, and swimming in the sea is not allowed after 19:00 because there is no lifeguard on duty. After 22:00 keep the television at volume 10 or below and do not use loudspeakers. Valuables belong in the in-room safe or with reception — the hotel is not liable for items left elsewhere. Guests who repeatedly break the rules can be asked to leave with no refund. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung",
      tags: ["visitors", "guest curfew", "pool", "swimming", "sea", "noise", "quiet hours", "safe", "valuables", "eviction"],
    },
    {
      category: "policy",
      title: "Payment methods and bank transfer details",
      body: "Payment is accepted by domestic debit card, credit card, QR code, cash or bank transfer. For a transfer to Vinpearl Resort Nha Trang the account is Chi nhanh Nha Trang - Cong Ty Co Phan Vinpearl, VND account 19127850127299 and USD account 19127850127094, at Techcombank Hoi so Chinh, SWIFT VTCBVNVX. The transfer memo must carry the guest or partner name, the booking request code and the type of payment. Where a technical or data error occurs Vinpearl may decline the transaction and refunds are made within a maximum of 45 working days. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-thanh-toan",
      tags: ["payment", "bank transfer", "card", "qr", "account number", "swift", "refund", "invoice"],
    },
    {
      category: "policy",
      title: "Complaints and dispute resolution",
      body: "Complaints go through three steps. Customer service or sales receive the complaint and answer immediately using the published policy. A complex case that cannot be answered on the spot gets a reply within 7 days at the latest. The outcome is then passed to the departments concerned and confirmed with the guest by telephone. Disputes are governed by Vietnamese law: the parties negotiate first, and if there is no agreement within 30 days the case goes to the competent Vietnamese court. The company is Cong ty Co phan Vinpearl, Hon Tre Island, Vinh Nguyen Ward, Nha Trang, Khanh Hoa, with a Hanoi office in the Symphony Tower, Chu Huy Man Street, Vinhomes Riverside, Long Bien. Hotline 1900 23 23 89, option 3. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-giai-quyet-tranh-chap",
      tags: ["complaint", "dispute", "escalation", "7 days", "hotline", "legal", "court", "contact"],
    },
    {
      category: "policy",
      title: "Personal data and privacy",
      body: "Vinpearl distinguishes basic personal data from sensitive personal data and processes it to deliver and support the service, to improve it, for marketing and to meet legal obligations. Data is stored in Vietnam and is never sold; it may be shared with Vingroup companies, service partners and the authorities where the law requires. Card numbers and CVV codes are not stored. A child's data needs a parent's consent, and from the age of 7 the child's own consent as well. Guests hold eleven rights over their data, including the right to be informed, to consent, to access, to withdraw consent, to delete, to restrict processing, to be given a copy, to object, to complain, to compensation and to protect themselves. Source: https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-quyen-rieng-tu",
      tags: ["privacy", "personal data", "gdpr", "consent", "children", "rights", "delete", "card", "cvv"],
    },
  ];
  kb.forEach((a) =>
    db
      .insert(kbArticles)
      .values({ hotelId: 1, ...a, tags: JSON.stringify(a.tags), updatedAt: iso(4000) })
      .run(),
  );

  /* ---------------- policy register (machine-readable rules) -----------
   * Transcribed from the published Vinpearl terms. The agent computes every
   * fee from these numbers — it is never allowed to invent one.
   * ------------------------------------------------------------------- */
  const BOOKING_TERMS = "https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong";
  const GENERAL_TERMS = "https://booking.vinpearl.com/vi-VND/dieu-khoan/dieu-khoan-chung";
  const HOUSE_RULES = "https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung";
  const PAYMENT_TERMS = "https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-thanh-toan";
  const DISPUTE_TERMS = "https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-giai-quyet-tranh-chap";
  const PRIVACY_TERMS = "https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-quyen-rieng-tu";

  const policyRows: Array<{
    code: string;
    topic: string;
    title: string;
    summary: string;
    rules: Record<string, unknown>;
    sourceUrl: string;
    sourceTitle: string;
  }> = [
    {
      code: "LATE_CHECKOUT",
      topic: "checkout",
      title: "Late departure charges",
      summary:
        "Check-out is no later than 12:00. Late departure depends on availability and is charged as a percentage of the package price: 50% for a departure between 12:00 and 18:00, and 100% after 18:00. The charge is calculated on the published rate and applies per room or villa, not per guest.",
      rules: {
        standard_checkout_time: "12:00",
        bands: [
          { from: "12:01", to: "18:00", pct: 50, label: "12:00–18:00" },
          { from: "18:01", to: "23:59", pct: 100, label: "after 18:00" },
        ],
        charged_per: "per room or villa, per stay",
        charge_base: "Giá Công Bố — Vinpearl's published package rate, or the contract rate when a partner settles the bill",
        subject_to_availability: true,
        max_when_room_resold: "14:00",
      },
      sourceUrl: BOOKING_TERMS,
      sourceTitle: "Vinpearl — Quy định về xác nhận đặt phòng",
    },
    {
      code: "EARLY_CHECKIN",
      topic: "checkin",
      title: "Early arrival charges",
      summary:
        "Early check-in must be confirmed in advance and is not granted before 12:00 free of charge. Arrival before 06:00 is charged 100% of the package price; arrival between 06:00 and 12:00 is charged 50%. The amount is payable as soon as the early arrival is confirmed.",
      rules: {
        standard_checkin_time: "14:00",
        bands: [
          { from: "00:00", to: "05:59", pct: 100, label: "before 06:00" },
          { from: "06:00", to: "11:59", pct: 50, label: "06:00–12:00" },
        ],
        payable: "immediately once the early arrival is confirmed",
        must_be_confirmed_in_advance: true,
        charge_base: "Giá Công Bố — Vinpearl's published package rate",
      },
      sourceUrl: BOOKING_TERMS,
      sourceTitle: "Vinpearl — Quy định về xác nhận đặt phòng",
    },
    {
      code: "OCCUPANCY",
      topic: "occupancy",
      title: "Occupancy, extra beds and children",
      summary:
        "A hotel room holds a maximum of 4 people including children under 4, as 3 adults + 1 child or 2 adults + 2 children, with at most one extra bed. A villa bedroom holds 2 adults + 2 children under 12 and no extra bed except at Vinpearl Luxury Nha Trang. The package price assumes 2 adults per room or per villa bedroom; children aged 4 to under 12 and guests 12 and over carry a surcharge.",
      rules: {
        hotel_room: {
          max_occupants_including_children_under_4: 4,
          allowed_combinations: ["3 adults + 1 child", "2 adults + 2 children"],
          max_extra_beds: 1,
          extra_bed_note: "Extra-bed availability depends on the individual hotel's policy.",
          package_default_adults: 2,
        },
        villa: {
          adults_per_bedroom: 2,
          children_under_12_per_bedroom: 2,
          extra_bed: "Not available in villas, except Vinpearl Luxury Nha Trang.",
          package_default_adults_per_bedroom: 2,
        },
        surcharge_note:
          "Children aged 4 to under 12 and guests aged 12 and over are surcharged, but the published terms do not state the amount — the front desk must confirm the exact figure.",
        age_by_height: {
          under_1m: "counts as under 4",
          "1m_to_1m40": "counts as 4 to under 12",
          over_1m40: "counts as 12 and over",
          applies_when: "no birth certificate is available to prove age",
        },
      },
      sourceUrl: BOOKING_TERMS,
      sourceTitle: "Vinpearl — Quy định về xác nhận đặt phòng",
    },
    {
      code: "DEPOSIT",
      topic: "deposit",
      title: "Check-in deposit",
      summary:
        "A deposit is taken at check-in: 1,000,000 VND per room and 3,000,000 VND per villa, refunded at check-out if there are no unpaid charges and no damage.",
      rules: {
        room: 1_000_000,
        villa: 3_000_000,
        currency: "VND",
        collected: "at check-in",
        refund: "returned in full at check-out when nothing is owed and nothing is damaged or missing",
      },
      sourceUrl: BOOKING_TERMS,
      sourceTitle: "Vinpearl — Quy định về xác nhận đặt phòng",
    },
    {
      code: "GUEST_LIST",
      topic: "booking",
      title: "Guest list deadlines, name changes and transfers",
      summary:
        "Individual bookings send the guest list 7 days ahead in low season, 15 days in high season and at booking in peak season and Tet. Changing a guest's identity after the deadline costs 350,000 VND per room per change. Flight details are due 5 days ahead and a transfer can only be changed or cancelled at least 72 hours before pick-up.",
      rules: {
        guest_list_deadline_days: { low_season: 7, high_season: 15, peak_and_tet: "at the time of booking" },
        identity_change_fee: 350_000,
        identity_change_fee_unit: "VND per room per change",
        identity_change_fee_waived_for: ["illness with proof", "natural disaster with proof"],
        flight_details_days_ahead: 5,
        transfer_change_or_cancel_hours: 72,
        meal_change_days_ahead: 5,
        meal_change_condition: "only for check-in before 13:00",
        shuttle_lobby_minutes_early: 15,
      },
      sourceUrl: BOOKING_TERMS,
      sourceTitle: "Vinpearl — Quy định về xác nhận đặt phòng",
    },
    {
      code: "BOOKING_CLASS",
      topic: "booking",
      title: "Booking classes, packages and early departure",
      summary:
        "Up to 9 rooms or 4 villas per night is an individual booking; 10 rooms or 5 villas and above is a group, and three or more groups on one itinerary form a series. The full package price is payable for the whole registered stay even if the guest departs early. A voucher must be surrendered at check-in or the published rate applies.",
      rules: {
        individual_max_rooms_per_night: 9,
        individual_max_villas_per_night: 4,
        group_min_rooms: 10,
        group_min_villas: 5,
        series_min_groups: 3,
        early_departure_refund: "none — the full package price for the registered stay remains payable",
        voucher: "must be presented and surrendered at check-in, otherwise the published rate is charged",
        relocation: "Vinpearl may move guests to an equivalent room or hotel in force majeure or renovation cases",
        package_codes: [
          "RO", "BB", "HB", "FB", "ROV", "BBV", "BBVS", "BBW", "FBV", "FBVS", "FBW",
          "FBSFD", "FVSFD", "FXSFD", "FWSFD", "FBBQD", "FVBQD", "FXBQD", "FWBQD", "G1P", "G2P",
        ],
        refund_window_working_days: 45,
      },
      sourceUrl: GENERAL_TERMS,
      sourceTitle: "Vinpearl — Điều khoản chung",
    },
    {
      code: "CONDUCT",
      topic: "conduct",
      title: "House rules and fines",
      summary:
        "No pets. Smoking outside the signed areas costs 3,000,000 VND per stay. Outside food and drink must be declared and carries a 1,175,000 VND service fee. No visitors in the rooms after 20:00, the pool closes by 22:00, no sea swimming after 19:00, and quiet hours start at 22:00.",
      rules: {
        pets: "not allowed anywhere on the property",
        smoking_fine: 3_000_000,
        smoking_fine_unit: "VND per stay, for smoking outside the signed smoking areas",
        outside_food_fee: 1_175_000,
        outside_food_fee_unit: "VND per occasion, and a liability waiver must be signed",
        banned_in_rooms: ["durian", "jackfruit", "strongly scented food", "weapons", "chemicals", "explosives"],
        villa_kitchen: "for reheating only; a barbecue must be registered with the Customer Service Centre and a fee applies",
        visitors: "leave an identity document at reception; no visitors in rooms after 20:00; overnight guests must be registered and paid for",
        pool_closes: "22:00 at the latest",
        sea_swimming_ends: "19:00 — no lifeguard on duty after that",
        quiet_hours_from: "22:00",
        quiet_hours_rule: "television at volume 10 or below, no loudspeakers",
        valuables: "in-room safe or reception; the hotel is not liable for items left elsewhere",
        repeat_violations: "the guest can be asked to leave with no refund",
      },
      sourceUrl: HOUSE_RULES,
      sourceTitle: "Vinpearl — Quy định chung",
    },
    {
      code: "PAYMENT",
      topic: "payment",
      title: "Payment methods and bank details",
      summary:
        "Domestic card, credit card, QR, cash or bank transfer. Transfers for Vinpearl Resort Nha Trang go to Chi nhánh Nha Trang – Công Ty Cổ Phần Vinpearl at Techcombank Hội sở Chính, VND 19127850127299 or USD 19127850127094, SWIFT VTCBVNVX, with the guest name, booking request code and payment type in the memo.",
      rules: {
        methods: ["domestic debit card", "credit card", "QR code", "cash", "bank transfer"],
        beneficiary: "Chi nhánh Nha Trang – Công Ty Cổ Phần Vinpearl",
        account_vnd: "19127850127299",
        account_usd: "19127850127094",
        bank: "Techcombank Hội sở Chính",
        swift: "VTCBVNVX",
        memo_must_include: ["guest or partner name", "booking request code", "type of payment"],
        refund_window_working_days: 45,
      },
      sourceUrl: PAYMENT_TERMS,
      sourceTitle: "Vinpearl — Quy định về thanh toán",
    },
    {
      code: "DISPUTE",
      topic: "dispute",
      title: "Complaints and dispute resolution",
      summary:
        "Customer service answers a straightforward complaint immediately from the published policy. A complex case gets a written reply within 7 days at the latest, is routed to the departments concerned and confirmed by telephone. Vietnamese law governs; negotiation first, then a competent Vietnamese court after 30 days.",
      rules: {
        step_1: "customer service or sales receive the complaint and answer immediately using the published policy",
        step_2: "a complex case receives a reply within 7 days at the latest",
        step_3: "the outcome is routed to the departments concerned and confirmed with the guest by telephone",
        complex_case_reply_days: 7,
        negotiation_days_before_court: 30,
        governing_law: "Vietnamese law, competent Vietnamese court",
        hotline: "1900 23 23 89, option 3",
        registered_office: "Công ty Cổ phần Vinpearl, Đảo Hòn Tre, P. Vĩnh Nguyên, Nha Trang, Khánh Hòa",
      },
      sourceUrl: DISPUTE_TERMS,
      sourceTitle: "Vinpearl — Chính sách giải quyết tranh chấp",
    },
    {
      code: "PRIVACY",
      topic: "privacy",
      title: "Personal data and privacy",
      summary:
        "Basic and sensitive personal data are processed to deliver and improve the service, for marketing and for legal obligations. Data is stored in Vietnam and never sold. Card numbers and CVV are not stored. A child's data needs parental consent, and the child's own consent from age 7. Guests hold eleven rights over their data.",
      rules: {
        storage_location: "Vietnam",
        never_sold: true,
        card_data: "card numbers and CVV codes are not stored",
        shared_with: ["Vingroup group companies", "service partners", "the authorities where the law requires"],
        child_consent_age: 7,
        child_consent_rule: "parental consent always; the child's own consent as well from age 7",
        data_subject_rights: [
          "be informed", "consent", "access", "withdraw consent", "delete", "restrict processing",
          "be given a copy", "object", "complain", "compensation", "self-protection",
        ],
      },
      sourceUrl: PRIVACY_TERMS,
      sourceTitle: "Vinpearl — Chính sách quyền riêng tư",
    },
    {
      code: "LOYALTY_LATE_CHECKOUT",
      topic: "checkout",
      title: "Loyalty goodwill on late departure (internal)",
      summary:
        "An Aurea-side goodwill rule, not a published Vinpearl policy: for gold, platinum and diamond guests the agent may waive the late-departure charge up to 14:00 when the room has not been resold. Anything later follows the published bands.",
      rules: {
        tiers: ["gold", "platinum", "diamond"],
        free_until: "14:00",
        condition: "the room must not have been resold for the same day",
        beyond: "the published Vinpearl bands apply in full",
      },
      sourceUrl: "internal://aurea/loyalty/late-checkout",
      sourceTitle: "Aurea internal loyalty rule — not published by Vinpearl",
    },
  ];
  policyRows.forEach((p) =>
    db
      .insert(policies)
      .values({ hotelId: 1, ...p, rules: JSON.stringify(p.rules), updatedAt: iso(4000) })
      .run(),
  );

  /* ---------------- offers (based on published promotions) ------------- */
  const offerRows = [
    {
      title: "Ocean view upgrade",
      body: "Move from a garden-view Deluxe to a Grand Deluxe Ocean View, 42 m² with a balcony over the bay, for 430,000 VND per night — subject to availability on the day.",
      segment: "in_house",
      price: 430_000,
    },
    {
      title: "VinWonders unlimited pass for two",
      body: "Stay 3 nights or more and take an unlimited VinWonders day pass for two guests, cable car included.",
      segment: "in_house",
      price: null,
    },
    {
      title: "Akoya Spa — 30% member discount",
      body: "Pearl Club members take 30% off any Akoya Spa treatment. The Balinese Massage 90' comes to 1,610,000 VND instead of 2,300,000.",
      segment: "vip",
      price: 1_610_000,
    },
    {
      title: "Saturday Groove & Grill",
      body: "Beach BBQ at Jasmine on Saturday, 18:30–22:00: welcome cocktail, grilled lobster and oysters, unlimited beer and soft drinks, live band. Price confirmed by F&B at booking.",
      segment: "in_house",
      price: null,
    },
    {
      title: "Return-stay hotel credit",
      body: "Book your next Vinpearl stay within 60 days and receive 300,000 VND hotel credit per room per night on stays of two nights or more.",
      segment: "departing",
      price: null,
    },
  ];
  offerRows.forEach((o) => db.insert(offers).values({ hotelId: 1, ...o, active: 1 }).run());

  /* ---------------- live conversations (guest side starts them) ------- */
  const allRes = storage.listReservations();
  allRes.forEach((r) => {
    const g = storage.getGuest(r.guestId)!;
    const conv = db
      .insert(conversations)
      .values({
        hotelId: 1,
        guestId: g.id,
        reservationId: r.id,
        channel: g.lang === "vi" ? "webchat" : "whatsapp",
        mode: "ai",
        assignedStaffId: null,
        sentiment: "neutral",
        topic: null,
        unreadForStaff: 0,
        lastMessageAt: iso(600),
        createdAt: iso(600),
        firstResponseSeconds: null,
      })
      .returning()
      .get();
    db.insert(messages)
      .values({
        conversationId: conv.id,
        role: "system",
        authorName: null,
        body: `Conversation opened on ${conv.channel} for reservation ${r.confirmationCode}.`,
        toolTrace: null,
        latencyMs: null,
        createdAt: iso(600),
      })
      .run();
  });

  /* ---------------- historical operations data (for insights) -------- */
  const depts = ["front_desk", "housekeeping", "fnb", "engineering", "spa"];
  const titles: Record<string, string[]> = {
    front_desk: [
      "Cable car ticket enquiry",
      "Buggy pick-up to the pier",
      "Late check-out request",
      "VinWonders ticket booking",
      "Airport transfer booking",
    ],
    housekeeping: ["Extra towels", "Turndown service", "Beach towel exchange", "Extra pillows requested"],
    fnb: ["In-room dining order", "Lotus buffet reservation", "Birthday cake setup", "Minibar restock"],
    engineering: ["Aircon too warm", "TV remote not pairing", "Balcony door sticking", "Safe reset"],
    spa: ["Akoya massage booking", "Reschedule treatment", "Aquafield entry question"],
  };
  const allStaff = storage.listStaff();
  let rnd = 42;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd / 2147483648;
  };
  for (let d = 13; d >= 0; d--) {
    const volume = 6 + Math.floor(rand() * 7);
    for (let i = 0; i < volume; i++) {
      const dept = depts[Math.floor(rand() * depts.length)];
      const list = titles[dept];
      const createdMinutesAgo = d * 1440 + Math.floor(rand() * 1200);
      const durationMin = 4 + Math.floor(rand() * 55);
      const done = d > 1 ? rand() > 0.04 : rand() > 0.55;
      const room = allRooms[Math.floor(rand() * allRooms.length)];
      const deptStaff = allStaff.filter((s) => s.dept === dept);
      const owner = deptStaff.length
        ? deptStaff[Math.floor(rand() * deptStaff.length)]
        : allStaff[0];
      db.insert(tasks)
        .values({
          hotelId: 1,
          reservationId: null,
          roomId: room.id,
          conversationId: null,
          dept,
          title: list[Math.floor(rand() * list.length)],
          detail: null,
          priority: rand() > 0.85 ? "high" : "normal",
          status: done ? "done" : rand() > 0.5 ? "in_progress" : "open",
          source: rand() > 0.3 ? "ai" : "staff",
          assignedStaffId: done || rand() > 0.4 ? owner.id : null,
          dueAt: iso(createdMinutesAgo - 30),
          createdAt: iso(createdMinutesAgo),
          resolvedAt: done ? iso(Math.max(0, createdMinutesAgo - durationMin)) : null,
        })
        .run();
    }
    // historical conversations for deflection / response metrics
    const convVolume = 5 + Math.floor(rand() * 6);
    for (let i = 0; i < convVolume; i++) {
      const g = storage.listGuests()[Math.floor(rand() * 8)];
      const handledByHuman = rand() > 0.78;
      const createdMinutesAgo = d * 1440 + Math.floor(rand() * 1300);
      db.insert(conversations)
        .values({
          hotelId: 1,
          guestId: g.id,
          reservationId: null,
          channel: ["whatsapp", "sms", "webchat", "voice"][Math.floor(rand() * 4)],
          mode: "closed",
          assignedStaffId: handledByHuman ? 1 + Math.floor(rand() * 6) : null,
          sentiment: rand() > 0.88 ? "negative" : rand() > 0.5 ? "positive" : "neutral",
          topic: ["cable car", "dining", "housekeeping", "billing", "vinwonders", "maintenance"][
            Math.floor(rand() * 6)
          ],
          unreadForStaff: 0,
          lastMessageAt: iso(createdMinutesAgo - 20),
          createdAt: iso(createdMinutesAgo),
          firstResponseSeconds: handledByHuman
            ? 180 + Math.floor(rand() * 900)
            : 2 + Math.floor(rand() * 8),
        })
        .run();
    }
  }

  db.insert(campaigns)
    .values({
      hotelId: 1,
      name: "Water-music show tonight",
      segment: "in_house",
      body: "Good afternoon from Vinpearl Resort Nha Trang. Tonight's water-music show and Tata Show run 19:00–20:00 at VinWonders. Tell us your room number and we will send an electric buggy 20 minutes beforehand.",
      recipients: 6,
      status: "sent",
      sentAt: iso(2880),
      createdAt: iso(3000),
    })
    .run();

  storage.logEvent({
    type: "system.seed",
    actor: "system",
    summary:
      "Vinpearl Resort Nha Trang property data, published rates, Akoya Spa menu, knowledge base and 14 days of operational history initialised.",
    payload: null,
    conversationId: null,
    createdAt: iso(0),
  });
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seedIfEmpty();
  console.log("seeded");
  sqlite.close();
}
