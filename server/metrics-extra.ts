/**
 * Histogram độ trễ, và những chỉ số LỖI mà người trực ca cần lúc ba giờ sáng.
 *
 * VÌ SAO HISTOGRAM CHỨ KHÔNG PHẢI TRUNG BÌNH
 *
 * `aurea_response_latency_avg_ms` là trung bình cộng. Một khách chờ 30 giây bị
 * một trăm khách chờ 6 giây kéo xuống thành "6,2s" — và 6,2s trông ổn. Suốt cả
 * quá trình đánh giá sản phẩm này, con số duy nhất có ý nghĩa là **p95**, mà
 * trung bình thì không bao giờ tính ra được p95.
 *
 * Prometheus tính phân vị từ histogram bằng `histogram_quantile()`, nên thứ
 * phải phơi ra là các XÔ (bucket) tích luỹ, không phải một con số đã bị bóp.
 *
 * Ranh giới xô chọn theo hình dạng THẬT của sản phẩm này, không phải mặc định
 * của thư viện: p50 đo được ~6,1s và p95 ~12,5s trên card 4GB. Một thang mặc
 * định kiểu 0,005–10s sẽ dồn gần như mọi lượt vào xô `+Inf` và không phân giải
 * được gì ở đúng vùng cần nhìn.
 *
 * VÌ SAO TỰ VIẾT CHỨ KHÔNG DÙNG `prom-client`
 *
 * Định dạng phơi bày của Prometheus là văn bản thuần và phần histogram chỉ là
 * mấy dòng cộng dồn. Thêm một phụ thuộc cho việc này đổi lấy một thư viện phải
 * theo dõi, trong khi `metrics.ts` sẵn có đã tự dựng chuỗi rồi. Nếu sau này cần
 * label đa chiều hay exemplar thì hãy đổi — lúc đó nó mới đáng.
 */

/** Ranh giới tính bằng mili giây, tăng dần. Xô `+Inf` được thêm tự động. */
export const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 6000, 8000, 12000, 20000, 30000, 60000];

class Histogram {
  private counts = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
  private sum = 0;
  private total = 0;

  observe(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.sum += ms;
    this.total++;
    /* Xô Prometheus là TÍCH LUỸ: một lượt 7s đếm vào le=8000, le=12000, … và
       cả +Inf. Chỉ tăng đúng một xô là biểu đồ sai mà không có gì báo. */
    let i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
    if (i < 0) i = LATENCY_BUCKETS_MS.length;
    for (let k = i; k < this.counts.length; k++) this.counts[k]++;
  }

  render(name: string, help: string): string[] {
    const out = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    LATENCY_BUCKETS_MS.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${this.counts[i]}`));
    out.push(`${name}_bucket{le="+Inf"} ${this.counts[this.counts.length - 1]}`);
    out.push(`${name}_sum ${Math.round(this.sum)}`);
    out.push(`${name}_count ${this.total}`);
    return out;
  }

  get count() {
    return this.total;
  }
}

export const chatLatency = new Histogram();

/* ------------------------------------------------------------------ *
 * Chỉ số lỗi
 * ------------------------------------------------------------------ */

/**
 * Đếm theo LỚP mã trạng thái, không theo từng mã.
 *
 * `{status="404"}` và `{status="409"}` tách riêng nghe có vẻ chi tiết hơn, nhưng
 * số nhãn khác nhau là thứ làm Prometheus phình bộ nhớ, và người trực ca hỏi
 * "có đang lỗi không", chứ không hỏi "có bao nhiêu cái 409".
 */
const httpByClass: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
export function recordHttpStatus(status: number) {
  const k = `${Math.floor(status / 100)}xx`;
  if (k in httpByClass) httpByClass[k]++;
}

/** Model không trả lời kịp — khác hẳn với model trả lời sai. */
let llmTimeouts = 0;
let llmErrors = 0;
export function recordLlmFailure(kind: "timeout" | "error") {
  if (kind === "timeout") llmTimeouts++;
  else llmErrors++;
}

/**
 * Truy xuất chạy nhưng không lấy được đoạn nào trên ngưỡng.
 *
 * Đây là chỉ số cảnh báo sớm quan trọng nhất của một hệ RAG: chỉ mục hỏng thì
 * con số này vọt lên trong khi mọi thứ khác vẫn xanh — server vẫn 200, model
 * vẫn trả lời, chỉ là trả lời mà không có tài liệu nào trong tay.
 */
let retrievalTotal = 0;
let retrievalEmpty = 0;
export function recordRetrieval(passageCount: number) {
  retrievalTotal++;
  if (passageCount === 0) retrievalEmpty++;
}

export function renderExtraMetrics(): string[] {
  const out: string[] = [];
  out.push(...chatLatency.render("aurea_chat_latency_ms", "Guest turn latency in milliseconds."));

  out.push(
    "# HELP aurea_http_responses_total HTTP responses served, by status class.",
    "# TYPE aurea_http_responses_total counter",
  );
  for (const [k, v] of Object.entries(httpByClass)) out.push(`aurea_http_responses_total{class="${k}"} ${v}`);

  out.push(
    "# HELP aurea_llm_timeouts_total Model calls abandoned on timeout.",
    "# TYPE aurea_llm_timeouts_total counter",
    `aurea_llm_timeouts_total ${llmTimeouts}`,
    "# HELP aurea_llm_errors_total Model calls that failed for any other reason.",
    "# TYPE aurea_llm_errors_total counter",
    `aurea_llm_errors_total ${llmErrors}`,
    "# HELP aurea_retrieval_total Retrieval attempts.",
    "# TYPE aurea_retrieval_total counter",
    `aurea_retrieval_total ${retrievalTotal}`,
    "# HELP aurea_retrieval_empty_total Retrieval attempts that returned no passage above threshold.",
    "# TYPE aurea_retrieval_empty_total counter",
    `aurea_retrieval_empty_total ${retrievalEmpty}`,
  );
  return out;
}

/** Chỉ dùng cho kiểm thử: xoá mọi bộ đếm về 0. */
export function __resetMetricsForTest() {
  for (const k of Object.keys(httpByClass)) httpByClass[k] = 0;
  llmTimeouts = 0;
  llmErrors = 0;
  retrievalTotal = 0;
  retrievalEmpty = 0;
}
