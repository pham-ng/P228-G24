import http from 'http';

function runDiag(name, payload) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = JSON.stringify(payload);
    console.log(`[${name}] Starting request at ${new Date().toISOString()}...`);
    const req = http.request('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const t1 = Date.now();
        console.log(`[${name}] Status: ${res.statusCode}, Elapsed: ${t1 - t0} ms, Body len: ${body.length}`);
        try {
          const parsed = JSON.parse(body);
          console.log(`[${name}] Content snippet:`, JSON.stringify(parsed.message?.content || '').slice(0, 100));
        } catch (e) {
          console.log(`[${name}] Parse error:`, e.message);
        }
        resolve();
      });
    });
    req.on('error', (err) => {
      console.log(`[${name}] Error: ${err.message}, Elapsed: ${Date.now() - t0} ms`);
      resolve();
    });
    req.write(data);
    req.end();
  });
}

async function main() {
  await runDiag('TEST_1_QWEN_CHAT', {
    model: 'qwen3.5:4b',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: false
  });
}
main();
