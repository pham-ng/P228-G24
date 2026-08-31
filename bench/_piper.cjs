const { spawn } = require("node:child_process");
const { join } = require("node:path");
const ROOT = join(process.cwd(), "models", "piper");
const run = (label, opts) =>
  new Promise((res) => {
    const p = spawn("./piper/piper.exe", ["--model", "./voices/vi_VN-vais1000-medium.onnx", "--output_raw"], opts);
    let n = 0, err = "";
    p.stdout.on("data", (d) => (n += d.length));
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", (e) => { console.log(`  ${label}: spawn error ${e.message}`); res(); });
    p.on("close", (code) => {
      console.log(`  ${label}: exit=${code} bytes=${n}${code ? "  err=" + err.slice(0, 90).replace(/\s+/g, " ") : ""}`);
      res();
    });
    p.stdin.write("Hồ bơi mở cửa từ sáu giờ sáng.\n");
    p.stdin.end();
  });

(async () => {
  await run("cwd=ROOT, env kế thừa   ", { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  await run("cwd=ROOT, shell=true    ", { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: true });
  await run("cwd=piper/ (cạnh DLL)   ", { cwd: join(ROOT, "piper"), stdio: ["pipe", "pipe", "pipe"] });
})();
