async function testToolCalling() {
  console.log("=== BƯỚC 5: KIỂM TRA TOOL CALLING CỦA QWEN3.5:4B ===");
  const payload = JSON.stringify({
    model: "qwen3.5:4b",
    messages: [
      { role: "user", content: "Tôi muốn kiểm tra thông tin chi tiết loại phòng Deluxe Ocean View" }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_room_type_facts",
          description: "Tra cứu thông tin chi tiết loại phòng",
          parameters: {
            type: "object",
            properties: {
              room_type: { type: "string", description: "Tên loại phòng" }
            },
            required: ["room_type"]
          }
        }
      }
    ],
    tool_choice: "auto"
  });

  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });

  const data = await res.json();
  console.log("Tool Calling Response:");
  console.log(JSON.stringify(data, null, 2));

  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    console.log("\n✅ KẾT QUẢ BƯỚC 5: Mô hình Qwen3.5-4B GỌI TOOL THÀNH CÔNG!");
    console.log("Tool Called:", toolCalls[0].function.name, "Args:", toolCalls[0].function.arguments);
  } else {
    console.log("\n⚠️ Response message content:", data.choices?.[0]?.message?.content);
  }
}

async function testLatencyAndSpeed() {
  console.log("\n=== BƯỚC 6: ĐO ĐỘ TRỄ & TỐC ĐỘ (PROMPT ~2.500 TOKENS) ===");
  const longContext = "Khách sạn Vinpearl Resort Nha Trang trên đảo Hòn Tre. ".repeat(150);
  const prompt = `Sau đây là bối cảnh dịch vụ khách sạn:\n${longContext}\n\nHãy tóm tắt ngắn gọn 3 dịch vụ nổi bật nhất.`;

  const payload = JSON.stringify({
    model: "qwen3.5:4b",
    messages: [{ role: "user", content: prompt }],
    stream: true,
    max_tokens: 100
  });

  const startTime = Date.now();
  let ttft = null;
  let tokenCount = 0;

  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      const text = decoder.decode(value);
      if (!ttft) {
        ttft = Date.now() - startTime;
      }
      const matches = text.match(/"content":"(.*?)"/g);
      if (matches) {
        tokenCount += matches.length;
      }
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  const generationTime = (totalTime * 1000 - (ttft || 0)) / 1000;
  const speed = generationTime > 0 ? (tokenCount / generationTime).toFixed(2) : "N/A";

  console.log(`⏱️ Thời gian tới token đầu tiên (TTFT): ${ttft} ms`);
  console.log(`⚡ Tổng số token sinh ra: ${tokenCount} tokens`);
  console.log(`⏱️ Tổng thời gian: ${totalTime.toFixed(2)}s`);
  console.log(`🚀 Tốc độ sinh: ${speed} tokens/giây`);
}

async function run() {
  await testToolCalling();
  await testLatencyAndSpeed();
}

run().catch(console.error);
