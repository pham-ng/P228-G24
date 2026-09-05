#!/usr/bin/env bash
# Chạy MỘT LẦN trên máy thuê, sau khi đã tạo repo riêng tư và dán deploy key.
#
#   bash /root/aurea/scripts/bat-sao-luu.sh git@github.com:TEN/REPO.git
#
# Nó khởi tạo kho sao lưu, đẩy lần đầu, rồi bật tiến trình chạy 30 phút một lần.
set -euo pipefail

URL=${1:-}
[ -n "$URL" ] || { echo "Thiếu URL. Ví dụ: bash $0 git@github.com:pham-ng/P228-G24-data.git"; exit 1; }
case "$URL" in
  git@*) ;;
  *) echo "Phải dùng dạng SSH (git@github.com:...), vì máy này xác thực bằng deploy key."; exit 1 ;;
esac

KHO=/root/aurea-data
KHOA=/root/.ssh/id_backup
export GIT_SSH_COMMAND="ssh -i $KHOA -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

[ -f "$KHOA" ] || { echo "Không thấy $KHOA — chưa tạo deploy key."; exit 1; }

mkdir -p "$KHO"
cd "$KHO"
[ -d .git ] || git init -q -b main
git remote remove origin 2>/dev/null || true
git remote add origin "$URL"

# Kiểm quyền GHI trước khi làm gì thêm: deploy key thiếu tick "Allow write
# access" là lỗi hay gặp nhất, và nó chỉ lộ ra ở lần push đầu.
echo "Kiểm kết nối tới GitHub…"
git ls-remote origin >/dev/null || {
  echo "KHÔNG kết nối được. Kiểm: repo đã tạo chưa, deploy key đã dán chưa."
  exit 1
}

printf '%s\n' "# Dữ liệu vận hành Aurea" "" \
  "Kho RIÊNG TƯ. Tự động cập nhật 30 phút một lần từ máy chạy vinaurea.id.vn." "" \
  "- \`bao-cao/\` — CSV + JSON đọc được ngay (hội thoại, tin nhắn, trace, lỗi)" \
  "- \`anh-chup/\` — bản sao \`data.db\` nén, mỗi ngày một bản, giữ 14 ngày" > README.md

bash /root/aurea/scripts/sao-luu-ra-ngoai.sh || true
git add -A
git -c user.name="Aurea backup" -c user.email="backup@vinaurea.id.vn" \
    commit -q -m "khởi tạo kho sao lưu" 2>/dev/null || true
git push -u origin HEAD

# Máy không có cron, nên dùng một tiến trình lặp tách khỏi phiên SSH.
pkill -f "sao-luu-vong-lap" 2>/dev/null || true
setsid bash -c 'exec -a sao-luu-vong-lap bash -c "while true; do /root/aurea/scripts/sao-luu-ra-ngoai.sh >> /root/sao-luu.log 2>&1; sleep 1800; done"' \
  < /dev/null > /dev/null 2>&1 &
disown 2>/dev/null || true

sleep 3
echo
echo "Xong. Kho: $URL"
echo "Lịch chạy: 30 phút/lần. Nhật ký: /root/sao-luu.log"
