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
  offers,
  campaigns,
} from "@shared/schema";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function seedIfEmpty() {
  migrate();
  const existing = db.select().from(hotels).limit(1).get();
  if (existing) return;

  /* ---------------- property ---------------- */
  db.insert(hotels)
    .values({
      name: "Aurea Riverside Hanoi",
      city: "Hanoi",
      timezone: "Asia/Bangkok",
      currency: "USD",
      checkInTime: "15:00",
      checkOutTime: "12:00",
      brandVoice:
        "Warm, precise and quietly confident. Aurea is a 92-key riverside property blending Vietnamese craft with contemporary calm. Never gushing, never robotic. Short sentences. Use the guest's name once, not repeatedly. Never invent facilities, prices or policies.",
      slaMinutes: 10,
      aiEnabled: 1,
    })
    .run();

  /* ---------------- staff ---------------- */
  const staffRows = [
    { name: "Linh Tran", role: "manager", dept: "front_desk", pin: "1234" },
    { name: "Marco Bellini", role: "agent", dept: "front_desk", pin: "1234" },
    { name: "Hoa Nguyen", role: "agent", dept: "housekeeping", pin: "1234" },
    { name: "Kenji Sato", role: "agent", dept: "fnb", pin: "1234" },
    { name: "Duc Pham", role: "agent", dept: "engineering", pin: "1234" },
    { name: "Amara Osei", role: "agent", dept: "spa", pin: "1234" },
  ];
  staffRows.forEach((s) => db.insert(staff).values({ ...s, active: 1 }).run());

  /* ---------------- rooms ---------------- */
  const types = ["Deluxe King", "Deluxe Twin", "Riverside Suite", "Junior Suite"];
  for (let floor = 3; floor <= 8; floor++) {
    for (let n = 1; n <= 4; n++) {
      const number = `${floor}0${n}`;
      db.insert(rooms)
        .values({
          number,
          type: types[(floor + n) % types.length],
          floor,
          status: n === 3 ? "dirty" : n === 4 && floor === 6 ? "out_of_order" : "clean",
          housekeepingNote:
            floor === 6 && n === 4 ? "Bathroom regrouting — blocked until Friday" : null,
        })
        .run();
    }
  }
  const allRooms = storage.listRooms();
  const roomByNumber = (num: string) => allRooms.find((r) => r.number === num)!;

  /* ---------------- guests + reservations ---------------- */
  const guestSeed = [
    {
      name: "Sophie Lauren",
      phone: "+33612480091",
      email: "s.lauren@example.fr",
      lang: "fr",
      vipTier: "gold",
      preferences: JSON.stringify(["High floor", "Feather-free pillows", "Still water"]),
      notes: "Architect. Travels for Vietnamese craft sourcing. Dislikes phone calls.",
      staysCount: 5,
      room: "801",
      code: "AUR-8F31KQ",
      checkIn: day(-2),
      checkOut: day(2),
      rate: 340,
      status: "in_house",
      source: "direct",
    },
    {
      name: "Nguyễn Thanh Hà",
      phone: "+84912004455",
      email: "ha.nguyen@example.vn",
      lang: "vi",
      vipTier: "platinum",
      preferences: JSON.stringify(["Quiet room", "Vietnamese breakfast", "Late checkout"]),
      notes: "Repeat corporate guest, books the Riverside Suite quarterly.",
      staysCount: 14,
      room: "802",
      code: "AUR-2M77VD",
      checkIn: day(-1),
      checkOut: day(1),
      rate: 520,
      status: "in_house",
      source: "direct",
    },
    {
      name: "Daniel Okafor",
      phone: "+2348031229087",
      email: "d.okafor@example.com",
      lang: "en",
      vipTier: "none",
      preferences: JSON.stringify(["Gym access early", "Extra towels"]),
      notes: null,
      staysCount: 1,
      room: "504",
      code: "AUR-5T09WB",
      checkIn: day(0),
      checkOut: day(3),
      rate: 265,
      status: "in_house",
      source: "booking.com",
    },
    {
      name: "Yuki Tanaka",
      phone: "+819044210087",
      email: "y.tanaka@example.jp",
      lang: "ja",
      vipTier: "silver",
      preferences: JSON.stringify(["Green tea in room", "Non-smoking floor"]),
      notes: "Honeymoon stay.",
      staysCount: 2,
      room: "703",
      code: "AUR-9K52JH",
      checkIn: day(-3),
      checkOut: day(0),
      rate: 410,
      status: "in_house",
      source: "direct",
    },
    {
      name: "Elena Petrova",
      phone: "+79161002233",
      email: "e.petrova@example.ru",
      lang: "en",
      vipTier: "none",
      preferences: JSON.stringify(["Airport transfer"]),
      notes: null,
      staysCount: 1,
      room: "402",
      code: "AUR-4Q18ZM",
      checkIn: day(1),
      checkOut: day(5),
      rate: 280,
      status: "confirmed",
      source: "expedia",
    },
    {
      name: "Carlos Mendes",
      phone: "+5511987650012",
      email: "c.mendes@example.br",
      lang: "es",
      vipTier: "gold",
      preferences: JSON.stringify(["Sparkling water", "Late dinner"]),
      notes: "Sommelier. Interested in tasting menus.",
      staysCount: 6,
      room: "601",
      code: "AUR-6B44LN",
      checkIn: day(-5),
      checkOut: day(-1),
      rate: 355,
      status: "checked_out",
      source: "direct",
    },
    {
      name: "Priya Raman",
      phone: "+919820011223",
      email: "p.raman@example.in",
      lang: "en",
      vipTier: "silver",
      preferences: JSON.stringify(["Vegetarian", "Yoga mat in room"]),
      notes: null,
      staysCount: 3,
      room: "303",
      code: "AUR-3D62XR",
      checkIn: day(2),
      checkOut: day(6),
      rate: 295,
      status: "confirmed",
      source: "ai_agent",
    },
    {
      name: "Trần Minh Quân",
      phone: "+84987112233",
      email: "quan.tran@example.vn",
      lang: "vi",
      vipTier: "none",
      preferences: JSON.stringify(["Twin beds", "Early breakfast"]),
      notes: null,
      staysCount: 1,
      room: "404",
      code: "AUR-7H23PC",
      checkIn: day(0),
      checkOut: day(2),
      rate: 240,
      status: "in_house",
      source: "direct",
    },
  ];

  guestSeed.forEach((g) => {
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
        roomId: roomByNumber(g.room).id,
        confirmationCode: g.code,
        checkIn: g.checkIn,
        checkOut: g.checkOut,
        checkOutTime: "12:00",
        adults: 2,
        children: 0,
        ratePerNight: g.rate,
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
        description: `Room ${g.room} — ${nights} night(s) @ ${g.rate}`,
        amount: nights * g.rate,
        category: "room",
        createdAt: iso(nights * 1440),
      })
      .run();
    // A handful of already-posted ancillary charges, so the folio and the
    // ancillary-revenue KPI reflect a property that has been trading.
    const extras: Array<{ d: string; a: number; c: string }> =
      g.status === "in_house"
        ? [
            { d: "Sông Restaurant — dinner for two", a: 78, c: "dining" },
            { d: "In-room dining — breakfast", a: 32, c: "roomservice" },
          ]
        : g.status === "checked_out"
          ? [
              { d: "Spa — Riverstone massage 60'", a: 95, c: "spa" },
              { d: "Airport transfer — private sedan", a: 34, c: "transport" },
              { d: "Minibar", a: 18.5, c: "minibar" },
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

  /* ---------------- services ---------------- */
  const svc = [
    {
      name: "Sông Restaurant — dinner",
      category: "dining",
      description:
        "Modern Vietnamese tasting menu on the 9th floor terrace overlooking the Red River. 5 or 8 courses.",
      price: 78,
      unit: "per person",
      dept: "fnb",
      slots: JSON.stringify(["18:00", "18:30", "19:00", "19:30", "20:00", "20:30"]),
      capacityPerSlot: 6,
    },
    {
      name: "Aurea Spa — Signature Ritual",
      category: "spa",
      description: "90-minute lemongrass and rice-bran body ritual with a herbal steam finish.",
      price: 120,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["10:00", "11:30", "13:00", "14:30", "16:00", "17:30"]),
      capacityPerSlot: 2,
    },
    {
      name: "Aurea Spa — Deep Tissue 60",
      category: "spa",
      description: "60-minute focused deep tissue massage with warm compress.",
      price: 85,
      unit: "per person",
      dept: "spa",
      slots: JSON.stringify(["09:00", "10:30", "12:00", "15:00", "16:30", "18:00"]),
      capacityPerSlot: 2,
    },
    {
      name: "Old Quarter craft walk",
      category: "experience",
      description:
        "Three-hour guided walk through Hàng Bạc silversmiths and Đồng Xuân market with an Aurea host.",
      price: 55,
      unit: "per person",
      dept: "front_desk",
      slots: JSON.stringify(["08:30", "14:00"]),
      capacityPerSlot: 8,
    },
    {
      name: "Airport transfer — private sedan",
      category: "transport",
      description: "Noi Bai Airport to Aurea in a private Mercedes E-Class. 45 minutes.",
      price: 42,
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
        "23:00",
      ]),
      capacityPerSlot: 3,
    },
    {
      name: "In-room dining — Phở bò",
      category: "roomservice",
      description: "Slow-simmered beef pho with brisket, served with herbs and chilli.",
      price: 16,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Bún chả cá",
      category: "roomservice",
      description: "Turmeric fish cake noodle soup, a Hanoi classic.",
      price: 15,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Club sandwich",
      category: "roomservice",
      description: "Free-range chicken, smoked bacon, fries. Available 24 hours.",
      price: 18,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "In-room dining — Vietnamese breakfast set",
      category: "roomservice",
      description: "Xôi, bánh cuốn, fresh fruit and cà phê sữa đá.",
      price: 22,
      unit: "per order",
      dept: "fnb",
      slots: JSON.stringify([]),
      capacityPerSlot: 99,
    },
    {
      name: "Riverside cabana half-day",
      category: "experience",
      description: "Private poolside cabana with fruit platter and two mocktails.",
      price: 65,
      unit: "per cabana",
      dept: "fnb",
      slots: JSON.stringify(["09:00", "14:00"]),
      capacityPerSlot: 4,
    },
  ];
  svc.forEach((s) => db.insert(services).values({ ...s, active: 1 }).run());

  /* ---------------- knowledge base ---------------- */
  const kb = [
    {
      category: "policy",
      title: "Check-in and check-out times",
      body: "Check-in from 15:00. Check-out by 12:00 noon. Early check-in from 11:00 is subject to availability and free of charge. Late check-out until 14:00 costs USD 40; until 18:00 is charged at half the nightly rate. Platinum and Gold members receive late check-out until 14:00 free of charge when the room is not resold.",
      tags: ["checkin", "checkout", "late checkout", "early"],
    },
    {
      category: "policy",
      title: "Cancellation and deposits",
      body: "Flexible rates may be cancelled free of charge until 18:00 local time on the day before arrival. Non-refundable rates are charged in full at booking. A pre-authorisation of USD 100 per stay is taken at check-in for incidentals and released within 7 working days.",
      tags: ["cancel", "deposit", "refund", "payment"],
    },
    {
      category: "policy",
      title: "Pets, smoking and children",
      body: "Aurea is entirely non-smoking, including balconies; a USD 250 cleaning fee applies to violations. Dogs under 10 kg are welcome for USD 30 per night in Deluxe rooms only. Children under 6 stay free using existing bedding. Cots are free; rollaway beds are USD 35 per night.",
      tags: ["pets", "dog", "smoking", "children", "cot"],
    },
    {
      category: "property",
      title: "Pool, gym and wellness hours",
      body: "The 9th-floor infinity pool is open 06:00–21:00. The gym on level 2 is open 24 hours with your room key. The spa reception is open 09:00–20:00; treatments must finish by 19:30. Sauna and steam are on level 2 and open 07:00–21:00.",
      tags: ["pool", "gym", "spa", "sauna", "hours"],
    },
    {
      category: "property",
      title: "Breakfast",
      body: "Breakfast is served in Sông Restaurant on level 9 from 06:30 to 10:30 (11:00 on weekends). It costs USD 26 per adult if not included in your rate; children under 12 are half price. A Vietnamese station with phở and bánh cuốn is available daily.",
      tags: ["breakfast", "dining", "hours"],
    },
    {
      category: "property",
      title: "Wi-Fi and connectivity",
      body: "Network name AUREA-GUEST. No password is required; open the browser and accept the terms. A premium 500 Mbps tier is free for all guests. If a device will not connect, front desk can register the MAC address manually.",
      tags: ["wifi", "internet", "password"],
    },
    {
      category: "property",
      title: "Parking and EV charging",
      body: "Basement parking is USD 12 per night per car, with 6 spaces. Two 22 kW EV chargers (Type 2) are on level B1 and are free while parking is paid. Motorbike parking is free.",
      tags: ["parking", "car", "ev", "charging"],
    },
    {
      category: "property",
      title: "Laundry and pressing",
      body: "Laundry collected before 09:00 is returned the same day by 18:00. Express 4-hour service costs 50% extra. Shirts USD 5, suits USD 18, dresses USD 12. There is no self-service laundry on site.",
      tags: ["laundry", "pressing", "dry cleaning"],
    },
    {
      category: "wayfinding",
      title: "Getting around the property",
      body: "Reception, concierge and the library are on the ground floor. Gym, spa, sauna and steam on level 2. Guest rooms on levels 3 to 8. Sông Restaurant, the bar, the pool and the terrace on level 9. Lifts require a room key after 22:00.",
      tags: ["where", "floor", "directions", "map"],
    },
    {
      category: "dining",
      title: "Sông Restaurant and the bar",
      body: "Sông serves a modern Vietnamese tasting menu, 5 courses for USD 78 or 8 courses for USD 115, from 18:00 to 22:30. The bar is open 16:00 to 01:00 with a Hanoi-focused cocktail list. Smart casual dress; no beachwear. In-room dining runs 24 hours.",
      tags: ["restaurant", "dinner", "bar", "menu", "reservation"],
    },
    {
      category: "neighborhood",
      title: "Nearby dining recommendations",
      body: "Bún chả Hương Liên (bún chả, 8 min by taxi), Chả cá Thăng Long (turmeric fish, 12 min), Cầu Gỗ Vietnamese Cuisine (rooftop views over Hoàn Kiếm lake, 10 min), Pizza 4P's Bao Khanh (family friendly, 11 min). Reservations recommended after 19:00 on weekends; concierge can book any of them.",
      tags: ["restaurant", "food", "nearby", "recommend"],
    },
    {
      category: "neighborhood",
      title: "Attractions and transport",
      body: "Hoàn Kiếm Lake and the Old Quarter are 10 minutes by taxi. The Temple of Literature is 15 minutes. Hồ Tây (West Lake) is 12 minutes. Noi Bai International Airport is 45 minutes; allow 70 minutes at rush hour (07:00–09:00 and 17:00–19:00). Grab is widely available; the hotel also runs a private sedan transfer.",
      tags: ["airport", "attraction", "taxi", "grab", "transport", "distance"],
    },
    {
      category: "property",
      title: "Accessibility",
      body: "Two fully accessible Deluxe King rooms (305 and 306) have roll-in showers and grab rails. All public areas including the pool deck are step-free. Portable induction loops are available at reception.",
      tags: ["accessible", "wheelchair", "disabled"],
    },
    {
      category: "policy",
      title: "Lost property and safety",
      body: "Found items are logged and kept for 90 days; unclaimed valuables are handed to the police. Each room has a laptop-sized safe. Fire assembly point is the riverside garden. First aid kits are at reception and level 9.",
      tags: ["lost", "safe", "security", "emergency"],
    },
  ];
  kb.forEach((a) =>
    db
      .insert(kbArticles)
      .values({ hotelId: 1, ...a, tags: JSON.stringify(a.tags), updatedAt: iso(4000) })
      .run(),
  );

  /* ---------------- offers ---------------- */
  const offerRows = [
    {
      title: "Riverside Suite upgrade",
      body: "Move up to a Riverside Suite with a river-facing terrace for USD 90 per night, subject to availability on the day.",
      segment: "in_house",
      price: 90,
    },
    {
      title: "Sông 8-course tasting menu",
      body: "Add the 8-course chef's tasting menu with a Vietnamese tea pairing for USD 115 per person.",
      segment: "in_house",
      price: 115,
    },
    {
      title: "Return-stay credit",
      body: "Book your next Aurea stay within 60 days and receive USD 75 resort credit plus guaranteed 14:00 check-out.",
      segment: "departing",
      price: null,
    },
    {
      title: "Spa duo ritual",
      body: "Two Signature Rituals side by side in the couples suite for USD 210 instead of USD 240.",
      segment: "vip",
      price: 210,
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
    front_desk: ["Late check-out request", "Airport transfer booking", "Extra key card", "Currency exchange question"],
    housekeeping: ["Extra towels", "Turndown service", "Room refresh", "Extra pillows requested"],
    fnb: ["In-room dining order", "Restaurant reservation", "Birthday cake setup", "Minibar restock"],
    engineering: ["Aircon too warm", "TV remote not pairing", "Slow shower drain", "Safe reset"],
    spa: ["Massage booking", "Reschedule treatment", "Couples suite request"],
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
          topic: ["amenities", "dining", "housekeeping", "billing", "transport", "maintenance"][
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
      name: "Pool maintenance notice — Thursday",
      segment: "in_house",
      body: "Good morning from Aurea. The infinity pool will close for filtration servicing on Thursday from 06:00 to 11:00. The sauna and steam on level 2 remain open. Apologies for the short notice.",
      recipients: 5,
      status: "sent",
      sentAt: iso(2880),
      createdAt: iso(3000),
    })
    .run();

  storage.logEvent({
    type: "system.seed",
    actor: "system",
    summary: "Property, PMS records, knowledge base and 14 days of operational history initialised.",
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
