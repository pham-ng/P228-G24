import "dotenv/config";

/**
 * One-shot probe: does the HF Inference API actually score a (query, passage)
 * PAIR for BAAI/bge-reranker-v2-m3, or does it fall back to something else?
 *
 * The Ollama package for this model turned out to expose only single-text
 * embedding — the exact opposite of what a cross-encoder is for. Before
 * building an ablation variant on top of the HF route, this makes one real
 * call and prints the raw response, so the assumption (sentence-pair
 * `{text, text_pair}` is accepted) is checked against reality rather than
 * against a generic docs page that only shows the single-string case.
 *
 *   npx tsx bench/probe-hf-rerank.ts
 */

const KEY = process.env.HF_API_KEY;
const MODEL = "BAAI/bge-reranker-v2-m3";
const URL = `https://router.huggingface.co/hf-inference/models/${MODEL}`;

async function tryCall(label: string, body: unknown) {
  console.log(`\n--- ${label} ---`);
  console.log("gửi:", JSON.stringify(body));
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`status: ${res.status}`);
    console.log("raw response:", text.slice(0, 500));
  } catch (e) {
    console.log("lỗi mạng:", String(e).slice(0, 200));
  }
}

async function main() {
  if (!KEY) {
    console.error("HF_API_KEY chưa có trong .env — dán token vào rồi chạy lại.");
    process.exit(2);
  }

  const query = "Spa mở cửa mấy giờ?";
  const relevant = "Akoya Spa on Hon Tre Island is open 09:00-22:00 and all prices include tax and service charge.";
  const irrelevant = "The resort has a 1.1 km private white-sand beach and a main swimming pool.";

  // [SEP] là dạng duy nhất pipeline chấp nhận (đã xác nhận qua lần chạy trước:
  // dạng text/text_pair trả lỗi 400 "missing 1 required positional argument").
  await tryCall("LIÊN QUAN (giờ spa, đúng đoạn văn)", {
    inputs: `${query} [SEP] ${relevant}`,
  });
  await tryCall("KHÔNG liên quan (giờ spa, đoạn văn về bãi biển)", {
    inputs: `${query} [SEP] ${irrelevant}`,
  });
  // Đối chứng thứ ba: câu hỏi khác hẳn domain, để chắc điểm số không phải hằng số.
  await tryCall("ĐỐI CHỨNG (câu hỏi vô nghĩa, không liên quan gì)", {
    inputs: `asdf qwerty 12345 [SEP] ${relevant}`,
  });
}

main();
