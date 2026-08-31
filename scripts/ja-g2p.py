"""
Chuyển một câu tiếng Nhật thành chuỗi âm vị cho Kokoro.

Đọc UTF-8 từ stdin, ghi âm vị ra stdout, thoát. Không giữ gì lại.

VÌ SAO PHẢI LÀ PYTHON. Kokoro sinh giọng Nhật tốt, nhưng nó cần âm vị tiếng
Nhật — và bộ chuyển chữ-sang-âm cho tiếng Nhật (OpenJTalk) là thư viện C, chỉ
có ràng buộc Python dùng được. `kokoro-js` phiên âm bằng quy tắc tiếng Anh, nên
đưa thẳng chữ Nhật vào cho ra tiếng Anh đọc chữ Nhật: đo được 15,2 giây âm
thanh cho một câu 2,5 giây, và Whisper nghe lại không nhận ra là tiếng nói.

VÌ SAO CHẠY MỘT LẦN RỒI THOÁT, KHÔNG THƯỜNG TRÚ. Nạp nguội hết 371–523 ms —
không có torch trong này, chỉ misaki + pyopenjtalk. So với 3,2 giây tổng hợp
thì chi phí đó nhỏ, và đổi lại là **không chiếm bộ nhớ khi rảnh**. Trên máy chỉ
còn khoảng 1 GB trống, một tiến trình thường trú sẽ lấy chỗ của Piper và của
model trả lời — đúng thứ chủ sản phẩm yêu cầu không được đụng tới.

    echo '朝食は何時までですか。' | python scripts/ja-g2p.py
    -> ʨoːɕokuwa naɴʥimadedesuka.__-------j__^____________j
"""

import sys

# Windows mặc định dùng bảng mã hệ thống cho stdio; không ép UTF-8 thì chữ Nhật
# vào đã hỏng trước khi tới được bộ phiên âm.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def main() -> int:
    text = sys.stdin.read().strip()
    if not text:
        print("không có gì để phiên âm", file=sys.stderr)
        return 2

    from misaki import ja

    # 'pyopenjtalk' chứ không phải 'cutlet': cutlet đi qua fugashi + unidic, mà
    # unidic phải tải riêng ~250 MB và trên đường dẫn có dấu tiếng Việt thì
    # MeCab không mở nổi tệp cấu hình. pyopenjtalk tự mang từ điển 22 MB.
    g2p = ja.JAG2P(version="pyopenjtalk")
    combined, _tokens = g2p(text)
    sys.stdout.write(strip_pitch(combined))
    return 0


def strip_pitch(combined: str) -> str:
    """Bỏ khối dấu trọng âm ở nửa sau.

    `misaki.ja` trả về `result + pitch` (ja.py dòng 356): nửa đầu là âm vị, nửa
    sau là dấu trọng âm dài ĐÚNG BẰNG nửa đầu, chỉ gồm các ký tự `_-^j`.

    Kokoro đọc luôn nửa sau thành tiếng. Đo được trên một câu trả lời thật:
    giữ nguyên → 15,6 giây và Whisper nghe ra đuôi thừa `…でございますいい`;
    bỏ đi → 14,5 giây và câu kết thúc sạch bằng `…でございます。`. Ký tự `j`
    trong khối dấu là một âm vị IPA có thật, nên nó được phát ra chứ không bị
    bỏ qua — đó là nguồn của tiếng lạ ở cuối mỗi câu.

    Chỉ cắt khi hai nửa đúng bằng nhau VÀ nửa sau chỉ chứa ký tự dấu. Nếu
    misaki đổi định dạng, hàm này trả nguyên chuỗi thay vì cắt bừa nửa câu.
    """
    n = len(combined)
    if n % 2:
        return combined
    head, tail = combined[: n // 2], combined[n // 2 :]
    if tail and all(c in "_-^j" for c in tail):
        return head
    return combined


if __name__ == "__main__":
    raise SystemExit(main())
