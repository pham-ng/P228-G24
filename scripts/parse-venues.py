#!/usr/bin/env python3
"""Turn the seven uploaded Vinpearl dining pages into structured facts.

Same doctrine as scripts/parse-room-types.py: a field the page does not publish
stays null. Nothing is inferred, averaged or filled in from another venue — the
concierge is only allowed to quote what the page itself says, so a missing price
range has to arrive at the agent as a missing price range.

Output: server/data/venues.json
"""

import json
import os
import re
import unicodedata

SRC = "/home/user/workspace/uploaded_attachments/890fedc1746f441ab131221ddbf905f5"
OUT = "/home/user/workspace/aurea/server/data/venues.json"

FILES = {
    "Lotus-Restaurant-2.txt": ("Lotus Restaurant", "restaurant"),
    "Nha-hang-Jasmine-3.txt": ("Jasmine Restaurant", "restaurant"),
    "Bach-Giai-Restaurant-6.txt": ("Bach Giai Restaurant", "restaurant"),
    "Halal-VietFlavors-restaurant.txt": ("Halal VietFlavors", "restaurant"),
    "Pool-bar-4.txt": ("Pool Bar", "bar"),
    "Seaview-Lounge-5.txt": ("Seaview Bar", "bar"),
    "Beachcomber-7.txt": ("Beach Comber Bar", "bar"),
}

# Published source URLs, taken from the "Nguồn" block of each file. Files whose
# Nguồn block names a page without printing its URL keep url = null rather than
# getting a plausible-looking link invented for them.
SOURCE_URLS = {
    "Lotus-Restaurant-2.txt": "https://www.foody.vn/khanh-hoa/lotus-restaurant-vinpearl-resort",
    "Pool-bar-4.txt": "https://vinpearl.com/vi/nha-trang/am-thuc/pool-bar-vinpearl-resort-nha-trang",
    "Seaview-Lounge-5.txt": "https://vinpearl.com/vi/hotels/vinpearl-resort-nha-trang/foods",
    "Beachcomber-7.txt": "https://vinpearl.com/vi/hotels/vinpearl-resort-nha-trang/foods",
    "Nha-hang-Jasmine-3.txt": None,
    "Bach-Giai-Restaurant-6.txt": None,
    "Halal-VietFlavors-restaurant.txt": None,
}

TIME_RANGE = re.compile(r"(\d{1,2})[:h](\d{2})\s*[-–]\s*(\d{1,2})[:h](\d{2})")
PRICE = re.compile(r"([\d][\d.,]*)\s*(?:đ|VND|vnd)", re.I)


def slug(name: str) -> str:
    s = unicodedata.normalize("NFD", name)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def read(path: str) -> list[str]:
    raw = open(path, "rb").read().decode("utf-8", errors="replace")
    return [l.strip() for l in raw.replace("\r\n", "\n").split("\n")]


def blocks(lines: list[str]) -> dict[str, list[str]]:
    """Group the file into `Label:` → bullet/plain lines under it."""
    out: dict[str, list[str]] = {}
    label = None
    for line in lines:
        if not line:
            continue
        if line.endswith(":") and len(line) < 60:
            label = line[:-1].strip()
            out.setdefault(label, [])
            continue
        item = line[1:].strip() if line.startswith("*") else line
        if label is None:
            out.setdefault("_head", []).append(item)
        else:
            out[label].append(item)
    return out


def money(text: str) -> int | None:
    m = PRICE.search(text)
    if not m:
        return None
    digits = re.sub(r"[.,]", "", m.group(1))
    if not digits.isdigit():
        return None
    value = int(digits)
    # Bach Giai prints "120.000đ"; anything that parses below 1.000 would be a
    # menu written in thousands, which none of these pages do — flag by skipping
    # rather than multiplying and inventing a price.
    return value if value >= 1000 else None


def hours(text: str) -> list[dict[str, str]]:
    return [
        {"open": f"{int(a):02d}:{b}", "close": f"{int(c):02d}:{d}"}
        for a, b, c, d in TIME_RANGE.findall(text)
    ]


def bullets(b: dict[str, list[str]], *labels: str) -> list[str]:
    for label in labels:
        if label in b:
            return [x for x in b[label] if x]
    return []


def first(b: dict[str, list[str]], *labels: str) -> str | None:
    got = bullets(b, *labels)
    return got[0] if got else None


def parse_menu_groups(lines: list[str]) -> list[dict]:
    """`Group:` headings followed by `dish — price` bullets (Bach Giai)."""
    groups: list[dict] = []
    current: dict | None = None
    for line in lines:
        if line.endswith(":"):
            current = {"group": line[:-1].strip(), "items": []}
            groups.append(current)
            continue
        if current is None:
            current = {"group": None, "items": []}
            groups.append(current)
        name = re.split(r"\s+[—–-]\s+", line)[0].strip()
        current["items"].append({"name_vi": name, "name_en": None, "price": money(line)})
    return [g for g in groups if g["items"]]


def parse_jasmine(lines: list[str]) -> list[dict]:
    """Numbered signature list with an English line and a `Price:` line."""
    items: list[dict] = []
    cur: dict | None = None
    for line in lines:
        num = re.match(r"^(\d+)\.\s*(.+)$", line)
        if num:
            cur = {"name_vi": num.group(2).strip(), "name_en": None, "price": None}
            items.append(cur)
            continue
        if cur is None:
            continue
        if line.lower().startswith("english:"):
            cur["name_en"] = line.split(":", 1)[1].strip()
        elif line.lower().startswith("price:"):
            cur["price"] = money(line)
    return [{"group": "Signature", "items": items}] if items else []


def build(fname: str, name: str, kind: str) -> dict:
    lines = read(os.path.join(SRC, fname))
    b = blocks(lines)
    text = "\n".join(lines)

    hour_lines = bullets(b, "Giờ mở cửa", "Giờ hoạt động")
    published_hours: list[dict[str, str]] = []
    for line in hour_lines:
        published_hours += hours(line)
    if not published_hours:
        # Lotus prints its service windows on a bare header line.
        published_hours = hours(text.split("\n\n")[0] if "\n\n" in text else text)
    if not published_hours:
        published_hours = hours(text)

    # Lotus prints meal windows ("Sáng: 6:00 - 10:30 Trưa: … Tối: …") on a header
    # line AND a single "Giờ hoạt động: 07:00 - 21:00" further down. Those two
    # disagree, so both are kept and the disagreement is handed to the agent
    # instead of one of them being silently dropped.
    meal_windows = []
    for line in lines:
        if re.search(r"(Sáng|Trưa|Tối)\s*:", line) and TIME_RANGE.search(line):
            for label, rng in re.findall(r"(Sáng|Trưa|Chiều|Tối)\s*:\s*([\d:h]+\s*[-–]\s*[\d:h]+)", line):
                got = hours(rng)
                if got:
                    meal_windows.append({"meal": label, **got[0]})

    phone = None
    for line in bullets(b, "Điện thoại") or lines:
        m = re.search(r"\(\+84\)\s*[\d\s]{6,}", line)
        if m:
            phone = re.sub(r"\s+", " ", m.group(0)).strip()
            break

    if fname == "Bach-Giai-Restaurant-6.txt":
        menu = parse_menu_groups(bullets(b, "Một số món tiêu biểu") or [])
        # The bullet groups sit under their own `Label:` lines, so re-read them
        # from the raw slice to keep the group names.
        chunk = text.split("Một số món tiêu biểu:", 1)[1].split("Thông tin giá:", 1)[0]
        menu = parse_menu_groups(
            [l[1:].strip() if l.startswith("*") else l for l in chunk.split("\n") if l.strip()]
        )
    elif fname == "Nha-hang-Jasmine-3.txt":
        chunk = text.split("MÓN ĐẶC BIỆT / SIGNATURE", 1)[-1]
        menu = parse_jasmine([l for l in chunk.split("\n") if l.strip()])
    else:
        menu = []

    price_range = first(b, "Khoảng giá")
    lo_hi = PRICE.findall(price_range or "")
    price_min = money(price_range.split("-")[0]) if price_range and "-" in price_range else None
    price_max = money(price_range.split("-")[-1]) if price_range and len(lo_hi) > 1 else None

    capacity_line = first(b, "Sức chứa")
    capacity = None
    if capacity_line:
        m = re.search(r"(\d[\d.,]*)", capacity_line)
        if m:
            capacity = int(re.sub(r"[.,]", "", m.group(1)))
    elif "250 thực khách" in text:
        capacity = 250  # Jasmine states it in prose, not in a labelled field.

    cuisine = bullets(b, "Đặc điểm ẩm thực", "Phong cách ẩm thực", "Ẩm thực") or bullets(
        b, "Đồ uống / ẩm thực", "Đồ uống / trải nghiệm"
    )
    types = bullets(b, "Loại hình")

    return {
        "code": name,
        "slug": slug(name),
        "kind": kind,
        "name_vi": first(b, "Tên") or name,
        "types": types,
        "location": " · ".join(bullets(b, "Vị trí", "Địa chỉ", "Khu vực")) or None,
        "phone": phone,
        "hours": published_hours,
        "meal_windows": meal_windows,
        "last_order": first(b, "Giờ nhận khách cuối"),
        "prep_time": first(b, "Thời gian chuẩn bị"),
        "capacity": capacity,
        "price_range": price_range,
        "price_min": price_min,
        "price_max": price_max,
        "price_note": " ".join(bullets(b, "Thông tin giá")) or None,
        "cuisine": cuisine,
        "dishes_served": bullets(b, "Các món phục vụ", "Một số món / nhóm món"),
        "highlights": bullets(b, "Đặc điểm"),
        "good_for": bullets(b, "Mục đích / nhóm khách phù hợp", "Phù hợp với"),
        "amenities": bullets(b, "Tiện ích được Foody ghi nhận"),
        "menu_groups": menu,
        "description": " ".join(bullets(b, "Mô tả")) or None,
        "source_file": fname,
        "source_url": SOURCE_URLS.get(fname),
    }


def main() -> None:
    venues = [build(f, n, k) for f, (n, k) in FILES.items()]
    venues.sort(key=lambda v: (v["kind"] != "restaurant", v["code"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(venues, open(OUT, "w"), ensure_ascii=False, indent=2)
    for v in venues:
        dishes = sum(len(g["items"]) for g in v["menu_groups"])
        priced = sum(1 for g in v["menu_groups"] for i in g["items"] if i["price"])
        print(
            f'{v["code"]:<22} {v["kind"]:<11} hours={len(v["hours"])} '
            f'dishes={dishes} priced={priced} cap={v["capacity"]} '
            f'range={v["price_range"] or "-"} phone={v["phone"] or "-"}'
        )
    print(f"\n{len(venues)} venues → {OUT}")


if __name__ == "__main__":
    main()
