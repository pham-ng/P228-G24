#!/usr/bin/env bash
# Đẩy dữ liệu vận hành RA KHỎI container. Chạy 30 phút một lần trên máy thuê.
#
# VÌ SAO CÓ TỆP NÀY. `server/backup.ts` vẫn sao lưu, nhưng ghi vào `backups/`
# ngay trên ổ đĩa nó đang bảo vệ. Xoá instance là mất cả bản gốc lẫn bản sao —
# đã xảy ra thật ngày 2026-09-01, mất toàn bộ hội thoại của 20 người thử. Sao
# lưu không rời khỏi máy thì chỉ chống ghi hỏng, không chống mất máy.
#
# VÌ SAO KHÔNG COMMIT data.db MỖI LẦN. Nó là tệp nhị phân ~1,6 MB mà git không
# delta được; 30 phút một lần là ~7 GB mỗi năm. Nên: bản CSV/JSON đi mỗi lần
# (diff theo dòng, gần như miễn phí), còn ảnh chụp .db nén thì mỗi ngày một lần.
set -uo pipefail

UNG_DUNG=${UNG_DUNG:-/root/aurea}
KHO=${KHO:-/root/aurea-data}
KHOA=${KHOA:-/root/.ssh/id_backup}
export GIT_SSH_COMMAND="ssh -i $KHOA -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

[ -d "$KHO/.git" ] || { echo "Chưa có kho $KHO — đọc docs/SAO-LUU.md"; exit 1; }
cd "$UNG_DUNG" || exit 1

# Ảnh chụp nhất quán: KHÔNG copy thô. WAL đang mở thì `cp data.db` cho ra tệp
# thiếu phần chưa checkpoint. `.backup()` của SQLite mới đúng.
node -e '
const D = require("better-sqlite3");
new D("data.db", { readonly: true }).backup("/tmp/anh-chup.db")
  .then(() => process.exit(0))
  .catch((e) => { console.error(e.message); process.exit(1); })' || exit 1

mkdir -p "$KHO/bao-cao"
( cd /tmp && cp anh-chup.db data.db \
  && node "$UNG_DUNG/scripts/xuat-bao-cao.mjs" "$KHO/bao-cao" >/dev/null \
  && rm -f data.db )

# Ảnh chụp .db: mỗi ngày một lần, nén lại, giữ 14 ngày.
NGAY=$(date +%Y%m%d)
if [ ! -f "$KHO/anh-chup/data-$NGAY.db.gz" ]; then
  mkdir -p "$KHO/anh-chup"
  gzip -c /tmp/anh-chup.db > "$KHO/anh-chup/data-$NGAY.db.gz"
  ls -1t "$KHO/anh-chup"/data-*.db.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
fi
rm -f /tmp/anh-chup.db

cd "$KHO" || exit 1
git add -A
# Không có gì đổi thì không tạo commit rỗng.
git diff --cached --quiet && { echo "$(date -Is) không có thay đổi"; exit 0; }
git -c user.name="Aurea backup" -c user.email="backup@vinaurea.id.vn" \
    commit -q -m "sao lưu $(date -Is)"
git push -q origin HEAD && echo "$(date -Is) đã đẩy" || echo "$(date -Is) PUSH HỎNG"
