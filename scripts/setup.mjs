#!/usr/bin/env node
/**
 * Một lệnh để một máy mới chạy được: `npm run setup`.
 *
 * VÌ SAO CÓ FILE NÀY. Model giọng nói nặng 1,19 GB — Piper 413 MB, Whisper và
 * Kokoro 770 MB. Không thứ nào commit được: GitHub chặn tệp trên 100 MB, và
 * Git LFS miễn phí chỉ cho 1 GB lưu trữ cộng 1 GB băng thông mỗi tháng, tức
 * một lần clone của một người là hết hạn mức của cả tháng.
 *
 * Trước đây `docs/SETUP-VOICE.md` mô tả mười mấy lệnh curl, và mỗi lệnh là một
 * chỗ để gõ sai. Script này làm đúng những bước đó, bỏ qua thứ đã có, và **nói
 * rõ thiếu gì** thay vì để server im lặng tắt tính năng — đúng cái bẫy mà
 * `jaAvailable()` từng cắn: một phép kiểm tệp sai một đoạn đường dẫn khiến
 * tiếng Nhật tắt mà không ai biết.
 *
 * Chạy lại bao nhiêu lần cũng được. `--verify` chỉ kiểm tra, không tải gì.
 * `--skip-ja` bỏ qua venv Python.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const CHI_KIEM = process.argv.includes("--verify");
const BO_QUA_JA = process.argv.includes("--skip-ja");

const PIPER_DIR = join(ROOT, "models", "piper");
const VOICE_DIR = join(PIPER_DIR, "voices");
const HF_DIR = join(ROOT, "models", "hf");
const VENV_DIR = join(ROOT, ".venv-tts-ja");
const PY_BIN = join(VENV_DIR, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const PIPER_BIN = join(PIPER_DIR, "piper", process.platform === "win32" ? "piper.exe" : "piper");

/* Bản phát hành Piper. Ghim phiên bản chứ không lấy "latest": bản sau đổi định
   dạng cấu hình giọng, và `server/tts.ts` được đo trên đúng bản này. */
const PIPER_TAG = "2023.11.14-2";
const PIPER_ASSET = {
  "win32-x64": "piper_windows_amd64.zip",
  "linux-x64": "piper_linux_x86_64.tar.gz",
  "linux-arm64": "piper_linux_aarch64.tar.gz",
  "darwin-x64": "piper_macos_x64.tar.gz",
  "darwin-arm64": "piper_macos_aarch64.tar.gz",
};

/* Năm giọng Piper. Tiếng Nhật KHÔNG có ở đây và đó là kết luận từ phép đo:
   giọng ja duy nhất của rhasspy khai `phoneme_type: "japanese"` (cần OpenJTalk),
   Piper 1.2.0 không có, nên nó nhồi âm vị espeak vào và phát âm sai mà không
   báo lỗi. Tiếng Nhật đi đường Kokoro ở bước 4. */
const VOICES = {
  vi: "vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium",
  en: "en/en_US/lessac/medium/en_US-lessac-medium",
  ko: "ko/ko_KR/kss/medium/ko_KR-kss-medium",
  zh: "zh/zh_CN/huayan/medium/zh_CN-huayan-medium",
  ru: "ru/ru_RU/irina/medium/ru_RU-irina-medium",
};
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

const STT_MODELS = ["huuquyet/PhoWhisper-small", "onnx-community/whisper-small"];
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

let hong = 0;

const log = (s = "") => console.log(s);
const ok = (s) => log(`  \x1b[32m✓\x1b[0m ${s}`);
const bo = (s) => log(`  \x1b[90m·\x1b[0m ${s}`);
const canh = (s) => log(`  \x1b[33m!\x1b[0m ${s}`);
const loi = (s) => {
  hong++;
  log(`  \x1b[31m✗\x1b[0m ${s}`);
};

function mb(p) {
  try {
    return (statSync(p).size / 1048576).toFixed(1) + " MB";
  } catch {
    return "?";
  }
}

/**
 * Tải một tệp, ghi ra đường dẫn tạm rồi mới đổi tên.
 *
 * Ghi thẳng vào đích là cách một lần Ctrl+C để lại một tệp `.onnx` cụt 40 MB mà
 * `existsSync` vẫn báo là có — lần chạy sau bỏ qua nó, rồi Piper chết lúc nạp
 * với `0xC0000409` và stderr rỗng. Đổi tên là thao tác nguyên tử, nên tệp ở
 * đích thì chắc chắn đã tải xong.
 */
async function tai(url, dich, nhan) {
  if (existsSync(dich)) {
    bo(`${nhan} — đã có (${mb(dich)})`);
    return true;
  }
  if (CHI_KIEM) {
    loi(`${nhan} — THIẾU`);
    return false;
  }
  mkdirSync(dirname(dich), { recursive: true });
  process.stdout.write(`  ↓ ${nhan} … `);
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error("tải về 0 byte");
    const tam = dich + ".part";
    writeFileSync(tam, buf);
    renameSync(tam, dich);
    log(`\x1b[32mxong\x1b[0m (${mb(dich)})`);
    return true;
  } catch (e) {
    log(`\x1b[31mhỏng\x1b[0m — ${e.message}`);
    hong++;
    return false;
  }
}

const chay = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });

/* ------------------------------------------------------- 1. Kiểm tra máy */

function buoc1() {
  log("\n\x1b[1m[1/5] Kiểm tra máy\x1b[0m");
  const v = Number(process.versions.node.split(".")[0]);
  if (v >= 20) ok(`Node ${process.versions.node}`);
  else loi(`Node ${process.versions.node} — cần 20 trở lên`);

  if (existsSync(join(ROOT, "node_modules", "@huggingface", "transformers")))
    ok("node_modules đã cài");
  else loi("Chưa có node_modules — chạy `npm install` trước");

  if (existsSync(join(ROOT, ".env"))) ok(".env có sẵn");
  else loi(".env thiếu — sao chép từ .env.example");

  if (existsSync(join(ROOT, "data.db"))) ok(`data.db (${mb(join(ROOT, "data.db"))})`);
  else canh("data.db chưa có — server sẽ tự seed lúc khởi động lần đầu");
}

/* --------------------------------------------------- 2. Nhị phân Piper */

async function buoc2() {
  log("\n\x1b[1m[2/5] Piper — nhị phân tổng hợp giọng\x1b[0m");
  if (existsSync(PIPER_BIN)) {
    bo(`piper — đã có (${mb(PIPER_BIN)})`);
    return;
  }
  if (CHI_KIEM) {
    loi("piper — THIẾU");
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const asset = PIPER_ASSET[key];
  if (!asset) {
    loi(`Chưa có bản Piper dựng sẵn cho ${key} — xem models/piper/README.md`);
    return;
  }

  const goi = join(PIPER_DIR, asset);
  if (!(await tai(`https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/${asset}`, goi, `piper (${asset})`)))
    return;

  /* Windows dùng Expand-Archive vì GNU tar trong Git Bash không mở được .zip;
     Linux/mac dùng tar cho .tar.gz. Không đoán một công cụ chung cho cả hai. */
  const r =
    process.platform === "win32"
      ? chay("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${goi}' -DestinationPath '${PIPER_DIR}' -Force`,
        ])
      : chay("tar", ["xzf", goi, "-C", PIPER_DIR]);
  rmSync(goi, { force: true });

  if (r.status === 0 && existsSync(PIPER_BIN)) ok(`piper giải nén xong (${mb(PIPER_BIN)})`);
  else loi("Giải nén Piper hỏng — giải tay theo models/piper/README.md");
}

/* ------------------------------------------------------ 3. Giọng Piper */

async function buoc3() {
  log("\n\x1b[1m[3/5] Piper — 5 giọng đọc (vi, en, ko, zh, ru)\x1b[0m");
  for (const [lang, path] of Object.entries(VOICES)) {
    const ten = path.split("/").pop();
    await tai(`${VOICE_BASE}/${path}.onnx`, join(VOICE_DIR, `${ten}.onnx`), `${lang} · ${ten}.onnx`);
    await tai(`${VOICE_BASE}/${path}.onnx.json`, join(VOICE_DIR, `${ten}.onnx.json`), `${lang} · cấu hình`);
  }
  if (CHI_KIEM) return;

  /**
   * Vá cấu hình giọng Hàn — bắt buộc, không phải tuỳ chọn.
   *
   * `ko_KR-kss-medium.onnx.json` có năm âm vị hai ký tự (`aɪ aʊ ɔɪ eɪ oʊ`,
   * nguyên âm đôi tiếng Anh) vì nó được huấn luyện bằng Piper mới hơn runtime
   * này. Piper 1.2.0 từ chối mọi khoá không phải một điểm mã đơn và **chết ngay
   * lúc nạp cấu hình**, trước cả khi tổng hợp, với `"aɪ" is not a single
   * codepoint`. espeak-ng cho tiếng Hàn không sinh nguyên âm đôi tiếng Anh, nên
   * gỡ chúng đi không mất gì.
   */
  const koCfg = join(VOICE_DIR, "ko_KR-kss-medium.onnx.json");
  if (existsSync(koCfg)) {
    const j = JSON.parse(readFileSync(koCfg, "utf8"));
    const thua = Object.keys(j.phoneme_id_map ?? {}).filter((k) => [...k].length > 1);
    if (thua.length) {
      writeFileSync(koCfg + ".goc", JSON.stringify(j));
      for (const k of thua) delete j.phoneme_id_map[k];
      writeFileSync(koCfg, JSON.stringify(j));
      ok(`giọng Hàn: gỡ ${thua.length} âm vị hai ký tự (${thua.join(" ")})`);
    } else bo("giọng Hàn: cấu hình đã sạch");
  }
}

/* -------------------------------------------- 4. Whisper + Kokoro (ONNX) */

async function buoc4() {
  log("\n\x1b[1m[4/5] Whisper (nhận dạng) + Kokoro (giọng Nhật) — 770 MB\x1b[0m");
  const coSan = (id) => existsSync(join(HF_DIR, ...id.split("/")));

  if (CHI_KIEM) {
    for (const m of [...STT_MODELS, KOKORO_MODEL]) (coSan(m) ? ok : loi)(coSan(m) ? m : `${m} — THIẾU`);
    return;
  }

  mkdirSync(HF_DIR, { recursive: true });
  const { pipeline, env } = await import("@huggingface/transformers");
  /* Trọng số nằm cạnh mã nguồn, không nằm trong cache hồ sơ người dùng: triển
     khai là một thư mục, và một máy ngắt mạng seed được bằng cách chép thư mục
     đó sang, không cần mạng. */
  env.cacheDir = HF_DIR;

  for (const id of STT_MODELS) {
    if (coSan(id)) {
      bo(`${id} — đã có`);
      continue;
    }
    process.stdout.write(`  ↓ ${id} … `);
    try {
      await pipeline("automatic-speech-recognition", id, { dtype: "q8", device: "cpu" });
      log("\x1b[32mxong\x1b[0m");
    } catch (e) {
      log(`\x1b[31mhỏng\x1b[0m — ${e.message}`);
      hong++;
    }
  }

  if (coSan(KOKORO_MODEL)) {
    bo(`${KOKORO_MODEL} — đã có`);
    return;
  }
  process.stdout.write(`  ↓ ${KOKORO_MODEL} … `);
  try {
    const { KokoroTTS, env: kenv } = await import("kokoro-js");
    kenv.cacheDir = HF_DIR;
    kenv.allowLocalModels = true;
    /* Chỉ ở ĐÂY mới cho tải từ mạng. `server/tts-ja.ts` đặt `allowRemoteModels
       = false` vì ngoại tuyến là một lời hứa của sản phẩm lúc chạy thật. */
    kenv.allowRemoteModels = true;
    await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" });
    log("\x1b[32mxong\x1b[0m");
  } catch (e) {
    log(`\x1b[31mhỏng\x1b[0m — ${e.message}`);
    hong++;
  }
}

/* ------------------------------------------------ 5. Python cho tiếng Nhật */

function timPython() {
  for (const c of ["python3", "python", "py"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    /* Windows có một "python" giả trong WindowsApps mở Microsoft Store rồi
       thoát. Chỉ nhận khi nó thật sự in ra số phiên bản 3.8 trở lên. */
    if (r.status === 0 && /Python 3\.(?:[89]|1\d)\b/.test((r.stdout || "") + (r.stderr || ""))) return c;
  }
  return null;
}

function buoc5() {
  log("\n\x1b[1m[5/5] Tiếng Nhật — venv Python cho phiên âm (tuỳ chọn)\x1b[0m");
  if (existsSync(PY_BIN)) {
    bo(`venv đã có (.venv-tts-ja)`);
    return;
  }
  if (CHI_KIEM) {
    canh("venv tiếng Nhật THIẾU — 5 ngôn ngữ kia vẫn chạy");
    return;
  }
  if (BO_QUA_JA) {
    bo("bỏ qua theo --skip-ja");
    return;
  }

  const bin = timPython();
  if (!bin) {
    canh("Không tìm thấy Python 3.8+ — tiếng Nhật sẽ tắt, 5 ngôn ngữ kia vẫn chạy đủ.");
    canh("Cài Python rồi chạy lại `npm run setup` là xong.");
    return;
  }
  log(`  · dùng ${bin}`);
  if (chay(bin, ["-m", "venv", VENV_DIR]).status !== 0) {
    loi("Tạo venv hỏng");
    return;
  }
  /* `misaki[ja]` kéo theo pyopenjtalk. KHÔNG có torch trong này — Python chỉ
     phiên âm, việc tổng hợp do Kokoro ONNX trong Node làm. Nên venv chỉ ~100 MB
     và nạp nguội 371–523 ms. */
  if (chay(PY_BIN, ["-m", "pip", "install", "--quiet", "misaki[ja]"]).status !== 0) {
    loi("pip install misaki[ja] hỏng — xem docs/SETUP-VOICE.md");
    return;
  }
  ok("venv tiếng Nhật sẵn sàng");
}

/* ------------------------------------------------------------- tổng kết */

function tongKet() {
  log("\n\x1b[1m── Kiểm tra lần cuối ──\x1b[0m");
  const hang = [
    [
      "Piper (5 giọng đọc: vi en ko zh ru)",
      existsSync(PIPER_BIN) &&
        Object.values(VOICES).every((p) => existsSync(join(VOICE_DIR, p.split("/").pop() + ".onnx"))),
      true,
    ],
    ["Whisper vi (PhoWhisper-small)", existsSync(join(HF_DIR, "huuquyet", "PhoWhisper-small")), true],
    ["Whisper đa ngôn ngữ (small)", existsSync(join(HF_DIR, "onnx-community", "whisper-small")), true],
    ["Kokoro (giọng Nhật)", existsSync(join(HF_DIR, "onnx-community", "Kokoro-82M-v1.0-ONNX")), true],
    ["venv tiếng Nhật (tuỳ chọn)", existsSync(PY_BIN), false],
  ];
  for (const [ten, co] of hang) log(`  ${co ? "\x1b[32m✓\x1b[0m" : "\x1b[33m—\x1b[0m"} ${ten}`);

  const batBuoc = hang.filter(([, , can]) => can).every(([, c]) => c);
  log("");
  if (batBuoc && hong === 0) {
    log("\x1b[32m\x1b[1mXong. Chạy `npm run dev` rồi mở http://localhost:5000\x1b[0m");
    log("Còn cần Ollama: cài từ https://ollama.com rồi `ollama pull qwen3.5:4b` và `ollama pull bge-m3`.");
  } else if (batBuoc) {
    log("\x1b[33mChạy được, nhưng có bước phụ chưa xong (xem dấu ✗ ở trên).\x1b[0m");
  } else {
    log("\x1b[31mThiếu model bắt buộc. Chạy lại `npm run setup`, hoặc làm tay theo docs/SETUP-VOICE.md.\x1b[0m");
    process.exitCode = 1;
  }
}

log("\x1b[1mAurea — chuẩn bị máy\x1b[0m" + (CHI_KIEM ? " (chỉ kiểm tra)" : ""));
buoc1();
await buoc2();
await buoc3();
await buoc4();
buoc5();
tongKet();
