# Bảng theo dõi vận hành — chạy và kiểm tra

Prometheus thu chỉ số từ ứng dụng, Grafana vẽ. Cả hai chạy trong Docker, cấu hình nằm hết trong thư mục này.

```bash
docker compose -f ops/docker-compose.obs.yml up -d
```

| | địa chỉ | tài khoản |
|---|---|---|
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | — |

**Cổng 3001 chứ không phải 3000** — cổng 3000 hay bị chính máy phát triển chiếm.

---

## Kiểm tra trước buổi demo — 4 lệnh

Chạy theo thứ tự. Lệnh nào cũng phải ra kết quả trước khi sang lệnh sau; mỗi lệnh loại bỏ đúng một tầng có thể hỏng.

**1. Ứng dụng có phát chỉ số không**

```bash
curl -s http://localhost:5000/metrics | grep -c "^aurea_"
```

Phải ra một số > 10. Ra 0 nghĩa là server chưa chạy.

**2. Prometheus có thu được không**

```bash
curl -s http://localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"'
```

Phải là `"health":"up"`. Nếu `down`, xem `lastError` trong cùng phản hồi — hay gặp nhất là thiếu `ops/scrape-token` (Prometheus bị 401 vì `/api/*` nằm sau `staffApiGuard`).

**3. Grafana có nạp được datasource và bảng không**

```bash
curl -s -u admin:admin http://localhost:3001/api/datasources
```

Phải thấy `"uid":"prometheus"`. **Mảng rỗng là hỏng** — xem mục sự cố bên dưới.

**4. Bảng có ra số thật không**

```bash
curl -s --get http://localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum(rate(aurea_chat_latency_ms_bucket[15m])) by (le)) > 0'
```

Ra `"value":[...,"18400"]` là đúng. Ra mảng `result` rỗng nghĩa là **chưa có lượt chat nào kể từ lần khởi động server gần nhất** — xem mục làm nóng.

---

## Làm nóng trước khi demo

Bộ đếm nằm trong bộ nhớ tiến trình và **về 0 mỗi lần khởi động lại server**. Prometheus giữ lịch sử, nhưng histogram độ trễ thì rỗng cho tới khi có lượt chat thật.

Nghĩa là: **khởi động server rồi mở Grafana ngay thì panel p95 trống.** Trước buổi demo hãy đi vài lượt chat thật qua kiosk hoặc:

```bash
curl -s -X POST http://localhost:5000/api/conversations/6/messages -H "Content-Type: application/json" -d "{\"body\":\"Hồ bơi mở cửa lúc nào ạ?\",\"from\":\"guest\"}"
```

Bốn lượt là đủ cho p95 có nghĩa. Đợi thêm ~30 giây để Prometheus thu hai chu kỳ.

---

## Sự cố đã gặp và cách sửa

### Grafana không có bảng nào, dù `ops/dashboards/vinaurea.json` tồn tại

`grafana-dashboards.yml` khai báo một provider đọc thư mục `/etc/grafana/provisioning/dashboards/json`, nhưng compose **không mount gì vào đó**. Thư mục rỗng → Grafana khởi động sạch sẽ, không báo lỗi, và không có bảng nào.

Một cấu hình provisioning không được gắn vào container thì im lặng y hệt như không tồn tại. Đã sửa: compose mount cả `grafana-dashboards.yml` lẫn `./dashboards`.

### `Datasource provisioning error: data source not found`, Grafana lặp khởi động

Volume `grafana-data` giữ sqlite nội bộ của Grafana. Nếu một lần ghi bị đứt giữa chừng (log có `database is locked (SQLITE_BUSY)`), bản ghi datasource hỏng dở và lần khởi động sau provisioning **chết hẳn** thay vì bỏ qua.

Volume đó không chứa gì cần giữ — mọi thứ đều provisioning từ file trong thư mục này. Dựng lại:

```bash
docker compose -f ops/docker-compose.obs.yml stop grafana && docker compose -f ops/docker-compose.obs.yml rm -f grafana && docker volume rm ops_grafana-data && docker compose -f ops/docker-compose.obs.yml up -d grafana
```

Giữ nguyên `prom-data` để không mất lịch sử chỉ số.

### Panel p95 hiện chữ `NaN`

`histogram_quantile` trên bucket toàn 0 trả về NaN, và Grafana in ra đúng chữ "NaN" — `noValue` **không** kích hoạt, vì truy vấn vẫn trả về một series. Mọi biểu thức histogram trong bảng đều kết thúc bằng `> 0` để loại mẫu NaN, khi đó không còn series nào và `noValue` mới hiện.

---

## Sửa bảng lúc demo

`allowUiUpdates: true`, nên kéo thả sửa tại chỗ được. Nhưng **sửa xong phải xuất JSON ra lại `ops/dashboards/vinaurea.json`** (Dashboard settings → JSON Model → copy), vì dựng lại container là mất.

Panel đều có `id` cố định. Đừng xoá — file provisioning được đọc lại mỗi 30 giây, và panel không có id sẽ bị dựng lại mỗi lần đọc, làm mất mọi chỉnh sửa trên giao diện.
