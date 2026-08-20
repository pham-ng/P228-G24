#!/usr/bin/env python3
"""Turn the hotel's own room-description pages into structured facts.

Input: the .txt exports of each room page on booking.vinpearl.com, as supplied by
the property. Output: server/data/room-types.json — one record per category, with
nothing inferred that the page does not say. A field the page is silent about is
written as null, never guessed, because the agent is only ever allowed to state
what is in this file.
"""
import json
import os
import re
import sys
import unicodedata

SRC = sys.argv[1]
OUT = sys.argv[2]

# vi name on the page  ->  the category name used in the inventory
INVENTORY = {
    "Deluxe Giường Đôi": "Deluxe Queen Bed",
    "Deluxe 2 Giường Đơn": "Deluxe Twin Bed",
    "Deluxe Hướng Biển Giường Đôi": "Deluxe Ocean View Queen Bed",
    "Deluxe Hướng Biển 2 Giường Đơn": "Deluxe Ocean View Twin Bed",
    "Grand Deluxe Giường Đôi": "Grand Deluxe Queen Bed",
    "Grand Deluxe 2 Giường Đơn": "Grand Deluxe Twin Bed",
    "Grand Deluxe Hướng Biển 2 Giường Đơn": "Grand Deluxe Ocean View Twin Bed",
    "Biệt Thự 3 Phòng Ngủ Hướng Biển": "Villa 3-Bedroom Ocean View",
    "Biệt thự Tropicana 3 phòng ngủ, hướng biển": "Tropicana Beachfront Villa 3-Bedroom",
}

SLUG = {
    "Deluxe Giường Đôi": "deluxe-giuong-doi",
    "Deluxe 2 Giường Đơn": "deluxe-2-giuong-don",
    "Deluxe Hướng Biển Giường Đôi": "deluxe-huong-bien-giuong-doi",
    "Deluxe Hướng Biển 2 Giường Đơn": "deluxe-huong-bien-2-giuong-don",
    "Grand Deluxe Giường Đôi": "grand-deluxe-giuong-doi",
    "Grand Deluxe 2 Giường Đơn": "grand-deluxe-2-giuong-don",
    "Grand Deluxe Hướng Biển 2 Giường Đơn": "grand-deluxe-huong-bien-2-giuong-don",
    "Biệt Thự 3 Phòng Ngủ Hướng Biển": "biet-thu-3-phong-ngu-huong-bien",
    "Biệt thự Tropicana 3 phòng ngủ, hướng biển": "biet-thu-tropicana-3-phong-ngu-huong-bien",
}


def undouble(line: str) -> str:
    """The exports repeat every amenity label twice ("Ban côngBan công")."""
    s = " ".join(line.split())
    n = len(s)
    if n % 2 == 0 and s[: n // 2] == s[n // 2 :]:
        return s[: n // 2].strip()
    # sometimes the two halves differ by a trailing space: "Tủ lạnh Tủ lạnh"
    for cut in range(2, n - 1):
        if s[:cut].strip() and s[:cut].strip() == s[cut:].strip():
            return s[:cut].strip()
    return s


def parse(path: str) -> dict:
    raw = open(path, encoding="utf-8").read().replace("\r", "")
    lines = [l.strip() for l in raw.split("\n") if l.strip()]
    name = lines[0]
    desc_lines = []
    i = 1
    while i < len(lines) and lines[i] != "Tiện ích":
        desc_lines.append(lines[i])
        i += 1
    description = " ".join(desc_lines)
    amenities, seen = [], set()
    for l in lines[i + 1 :]:
        a = undouble(l)
        k = unicodedata.normalize("NFC", a).lower()
        if a and k not in seen:
            seen.add(k)
            amenities.append(a)

    area = None
    m = re.search(r"diện tích\s*([\d.,]+)\s*m2?²?", description, re.I)
    if m:
        area = float(m.group(1).replace(",", "."))

    bedrooms = None
    m = re.search(r"(\d+)\s*phòng ngủ", description, re.I)
    if m:
        bedrooms = int(m.group(1))

    occupancy = None
    m = re.search(r"Tối đa\s*(\d+)\s*người trong một phòng\s*\(([^)]+)\)", description, re.I)
    if m:
        combos = []
        for part in re.split(r"\s*hoặc\s*", m.group(2)):
            a = re.search(r"(\d+)\s*người lớn", part)
            c = re.search(r"(\d+)\s*trẻ em", part)
            if a:
                combos.append({"adults": int(a.group(1)), "children": int(c.group(1)) if c else 0})
        occupancy = {"max_guests": int(m.group(1)), "combinations": combos}

    low = description.lower() + " " + " ".join(amenities).lower()
    return {
        "name_vi": name,
        "inventory_type": INVENTORY.get(name),
        "area_sqm": area,
        "bedrooms": bedrooms,
        "bed": "twin" if "2 giường đơn" in name.lower() else ("double" if "giường đôi" in name.lower() else None),
        "ocean_view": "hướng biển" in name.lower() or "hướng đại dương" in low or "hướng ra biển" in low,
        "private_pool": "hồ bơi riêng" in low or "bể bơi riêng" in low,
        "occupancy": occupancy,
        "description": description,
        "amenities": amenities,
        "source_file": os.path.basename(path),
        "source_url": f"https://booking.vinpearl.com/vi-VND/khach-san/vinpearl-resort-nha-trang#{SLUG.get(name, '')}",
    }


records = [parse(os.path.join(SRC, f)) for f in sorted(os.listdir(SRC)) if f.endswith(".txt")]
records.sort(key=lambda r: (r["area_sqm"] or 0, r["name_vi"]))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(records, open(OUT, "w"), ensure_ascii=False, indent=2)
print(f"{len(records)} categories → {OUT}")
for r in records:
    print(
        f"  {r['name_vi']:45} → {r['inventory_type'] or 'NO INVENTORY MATCH':38} "
        f"{r['area_sqm']}m² occ={r['occupancy']['max_guests'] if r['occupancy'] else '—'} "
        f"amenities={len(r['amenities'])}"
    )
