/**
 * Sinh bảng chấm tay (bấm chọn) và nạp điểm giám khảo vào report.
 *
 *   npx tsx bench/make-label-sheet.ts            # tất cả ca đã có điểm giám khảo
 *   npx tsx bench/make-label-sheet.ts --n 40     # lấy mẫu phân tầng 40 ca
 *
 * Ba quyết định trong file này, mỗi cái đều là một cách kappa có thể bị làm hỏng:
 *
 * 1. **Điểm của giám khảo bị GIẤU cho tới khi người chấm xong từng ca.** Nhìn
 *    trước là mỏ neo; kappa đo lúc đó chỉ nói lên rằng người ta biết đọc số.
 *
 * 2. **Thứ tự ca được xáo bằng seed cố định.** Nếu để nguyên thứ tự id thì cả
 *    một cụm VI-U-* (toàn ca phải từ chối) nằm liền nhau, và người chấm học được
 *    nhịp "cứ 3 điểm là xong" trước khi tới ca khó. Xáo bằng seed nên vẫn lặp lại
 *    được — đúng khuyến nghị "randomize order" của slide.
 *
 * 3. **Mẫu phân tầng theo hạng mục, không lấy ngẫu nhiên đều.** PRICING là chỗ
 *    yếu nhất (44%) và UNANSWERABLE là chỗ mạnh nhất (92%); lấy đều tay sẽ nhồi
 *    bảng bằng những ca ai cũng chấm 3, và kappa cao một cách vô nghĩa vì không
 *    có gì để bất đồng.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { HANDLING, SOURCE } from "./rubric";

type Golden = { id: string; category: string; behaviour: string; question: string; ground_truth: string; why: string };
type Row = { id: string; reply: string | null; observed: string; expected: string; contextRecall?: number };
type Judge = { correctness: number; faithfulness: number; note?: string };

const golden = JSON.parse(readFileSync("bench/data/golden-vi.json", "utf8")) as { cases: Golden[] };
const report = JSON.parse(readFileSync("bench/rag-eval-report.json", "utf8")) as { judgeModel: string | null; rows: Row[] };
/**
 * Bảng này KHÔNG còn hiện điểm của giám khảo máy nữa, vì hai lý do.
 *
 * Thứ nhất: `bench/data/judge-claude.json` chấm theo thang số cũ (0–3 / 0–2)
 * mà thang danh mục mới đã thay thế. Một nhãn "3" cũ không quy đổi được sang
 * "dung_du" hay "hop_ly" — đó là hai chuyện khác nhau, và chính chỗ lẫn lộn ấy
 * đã dìm kappa. Quy đổi máy móc sẽ trông như một lượt chấm mới trong khi vẫn
 * mang nguyên thiên lệch cũ.
 *
 * Thứ hai, quan trọng hơn: bản cũ lộ điểm máy ngay sau khi người chấm bấm xong
 * một ca. Giấu tới lúc bấm xong thì tránh được mỏ neo TRONG ca đó, nhưng không
 * tránh được mỏ neo cho những ca SAU — tới ca thứ ba mươi thì người ta đã học
 * được cách máy nghĩ. Kappa đo sau đó là đo sự đồng hoá, không phải đồng thuận.
 *
 * Trình tự đúng: người chấm mù → chạy giám khảo máy trên CÙNG bộ luật
 * (`bench/rubric.ts`) → mới đem hai bên ra so.
 */
/* --- 2. Chọn mẫu --- */
const nArg = process.argv.indexOf("--n");
const want = nArg >= 0 ? Number(process.argv[nArg + 1]) : 0;

/**
 * Chấm lại một tập ca CỤ THỂ.
 *
 *   --ids VI-P-02,VI-C-05
 *   --ids-file bench/data/relabel-ids.json
 *
 * Có để không phải bấm lại cả 101 ca khi bộ luật chỉ thêm một ô. Mười ba ca
 * "im lặng dù có tài liệu" đã bị chấm thành bốn nhãn khác nhau vì lúc đó chưa
 * có ô `im_lang`; chỉ những ca đó cần bấm lại.
 */
const idsArg = process.argv.indexOf("--ids");
const idsFileArg = process.argv.indexOf("--ids-file");
let only: Set<string> | null = null;
if (idsArg >= 0) only = new Set(String(process.argv[idsArg + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
else if (idsFileArg >= 0)
  only = new Set(JSON.parse(readFileSync(process.argv[idsFileArg + 1], "utf8")) as string[]);
if (only && only.size === 0) {
  console.error("--ids / --ids-file được đưa vào nhưng rỗng — không sinh bảng trống.");
  process.exit(2);
}

const byId = new Map(golden.cases.map((c) => [c.id, c]));
const scored = report.rows.filter((r) => byId.has(r.id) && (!only || only.has(r.id)));

/** Mulberry32 — seed cố định nên bảng sinh ra hôm nay và tuần sau giống nhau. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const shuffle = <T,>(a: T[]) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

if (only) {
  const missing = [...only].filter((id) => !scored.some((r) => r.id === id));
  if (missing.length) {
    console.error(`Không tìm thấy trong báo cáo: ${missing.join(", ")}`);
    process.exit(2);
  }
}

let picked = scored;
if (want > 0 && want < scored.length) {
  /* Phân tầng: chia đều theo hạng mục rồi bù phần dư cho hạng mục nhiều ca nhất. */
  const groups = new Map<string, Row[]>();
  for (const r of scored) {
    const cat = byId.get(r.id)!.category;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(r);
  }
  const cats = [...groups.keys()].sort();
  const per = Math.max(1, Math.floor(want / cats.length));
  const out: Row[] = [];
  for (const c of cats) out.push(...shuffle(groups.get(c)!).slice(0, per));
  const rest = shuffle(scored.filter((r) => !out.includes(r)));
  picked = [...out, ...rest.slice(0, Math.max(0, want - out.length))];
}
picked = shuffle(picked);

/* --- 3. Sinh HTML --- */
const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Nút sinh thẳng từ `bench/rubric.ts`: sửa luật ở một chỗ, cả bảng bấm lẫn
 *  prompt giám khảo đổi theo, không có đường nào để hai bên lệch nhau. */
const btns = (cs: { value: string; label: string; hint: string }[]) =>
  cs
    .map((c, k) => `<button value="${c.value}" title="${esc(c.hint)}"><i>${k + 1}</i>${esc(c.label)}</button>`)
    .join("");

const cards = picked
  .map((r, i) => {
    const c = byId.get(r.id)!;
    const reply = r.reply?.trim() ? r.reply : "(hệ thống không trả lời — đã chuyển người)";
    return `
<article class="card" data-id="${esc(r.id)}">
  <header><span class="n">${i + 1}/${picked.length}</span><span class="id">${esc(r.id)}</span><span class="cat">${esc(c.category)}</span></header>
  <div class="q"><b>Khách hỏi</b><p>${esc(c.question)}</p></div>
  <div class="gt"><b>Đáp án chuẩn</b><p>${esc(c.ground_truth)}</p></div>
  <div class="a"><b>Hệ thống trả lời</b><p>${esc(reply)}</p></div>
  <div class="row"><b>Hệ thống có làm đúng việc cần làm không?</b>
    <div class="btns" data-field="handling">${btns(HANDLING)}</div>
  </div>
  <div class="row"><b>Lời nói dựa trên cái gì?</b>
    <div class="btns" data-field="source">${btns(SOURCE)}</div>
  </div>
  <div class="after"></div>
</article>`;
  })
  .join("");

const html = `<!doctype html>
<meta charset="utf-8">
<title>Chấm tay — ${picked.length} ca</title>
<style>
 :root{--bg:#fff;--fg:#111;--mut:#666;--line:#e3e3e3;--acc:#0a7;--warn:#c33}
 @media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#333}}
 *{box-sizing:border-box}
 body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,Segoe UI,sans-serif;max-width:780px;margin:0 auto;padding:24px 16px 130px}
 h1{font-size:20px;margin:0 0 4px}
 .lead{color:var(--mut);font-size:13px;margin:0 0 20px}
 .card{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 16px}
 .card.done{opacity:.45}
 header{display:flex;gap:10px;align-items:center;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
 .id{font-weight:700;color:var(--fg)}
 .q p,.gt p,.a p{margin:2px 0 12px}
 .gt{color:var(--mut)}
 .a p{padding:8px 10px;background:rgba(128,128,128,.10);border-radius:6px;white-space:pre-wrap}
 b{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--mut)}
 .row{margin-top:10px}
 .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
 button{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:5px;cursor:pointer}
 button:hover{border-color:var(--acc)}
 button.sel{background:var(--acc);border-color:var(--acc);color:#fff}
 button i{font-style:normal;opacity:.5;margin-right:6px;font-size:11px}
 button.sel i{opacity:.8}
 .after{margin-top:9px;font-size:12px;color:var(--mut);min-height:1em}
 .after.diff{color:var(--warn);font-weight:600}
 footer{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:11px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
 #out{width:100%;height:180px;font:12px/1.4 ui-monospace,monospace;margin-top:14px;display:none}
</style>
<h1>Chấm tay ${picked.length} ca</h1>
<p class="lead">Chấm theo cảm nhận của một nhân viên lễ tân: hệ thống có làm đúng việc cần làm không.
<b>Chuyển đúng người khi thiếu căn cứ, hoặc hỏi lại khi câu mơ hồ, đều là “Hợp lý”</b> — không phải thất bại.
Điểm của giám khảo máy <b>không hiện ở đây</b>: nhìn được nó thì tới ca thứ ba mươi bạn đã chấm theo máy, và phép đo mất ý nghĩa.
Di chuột lên nút để xem giải thích. Bấm phím số để chấm nhanh mục đang mở. Xong thì bấm “Xuất JSON” và lưu vào <code>bench/data/human-labels.json</code>.</p>
${cards}
<footer>
  <span id="prog">0/${picked.length}</span>
  <button id="save">Xuất JSON</button>
  <button id="clear">Xoá hết</button>
  <span id="saved" style="display:none;font-size:12px;color:var(--acc)"></span>
</footer>
<textarea id="out" spellcheck="false"></textarea>
<script>
const KEY = "aurea-labels-v3-danhmuc";
/* Chrome CHẶN localStorage trên file:// — mở bảng này bằng cách bấm đúp vào file
   thì mọi lần đọc/ghi đều ném SecurityError và trang chết ngay ở cú bấm đầu
   tiên. Đo được, không phải phỏng đoán. Nên bọc lại và lùi về bộ nhớ tạm: mất
   khả năng lưu qua lần tải lại, nhưng chấm xong một lượt rồi Xuất JSON vẫn chạy.
   Muốn giữ tiến độ thì phục vụ qua http (xem hướng dẫn cuối script). */
let mem = {};
const LS = {
  ok: true,
  read(){ try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch(_) { this.ok=false; return mem; } },
  write(v){ mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch(_) { this.ok=false; } },
  clear(){ try { localStorage.removeItem(KEY); } catch(_) {} mem = {}; }
};
const store = LS.read();

function paint(card){
  const id = card.dataset.id, rec = store[id] || {};
  for (const box of card.querySelectorAll(".btns")){
    const f = box.dataset.field;
    for (const b of box.querySelectorAll("button")) b.classList.toggle("sel", String(rec[f]) === b.value);
  }
  const after = card.querySelector(".after");
  if (rec.handling === undefined || rec.source === undefined){ after.textContent=""; card.classList.remove("done"); return; }
  card.classList.add("done");
  after.textContent = "đã chấm";
}
function progress(){
  const n = document.querySelectorAll(".card").length;
  const d = Object.values(store).filter(r => r.handling !== undefined && r.source !== undefined).length;
  document.getElementById("prog").textContent = d + "/" + n;
}
for (const card of document.querySelectorAll(".card")){
  card.addEventListener("click", e => {
    const b = e.target.closest("button"); if(!b) return;
    const f = b.closest(".btns").dataset.field, id = card.dataset.id;
    (store[id] = store[id] || {})[f] = b.value;
    LS.write(store);
    paint(card); progress();
  });
  paint(card);
}
progress();
if (!LS.ok) {
  const w = document.createElement("p");
  w.style.cssText = "color:var(--warn);font-size:13px;border:1px solid var(--warn);border-radius:6px;padding:9px 11px";
  w.textContent = "Trình duyệt không cho lưu tiến độ khi mở bằng file:// — chấm xong hãy bấm Xuất JSON NGAY, đừng tải lại trang. Muốn lưu được thì chạy: npx serve bench/data (hoặc mở qua http).";
  document.querySelector(".lead").after(w);
}
/* Bấm số để chấm ô đang hiện giữa màn hình — chấm 100 ca bằng chuột thì mỏi.
   Số trên mỗi nút chính là phím của nó, nên không phải nhớ gì. */
const HV = ["hop_ly","dung_du","thieu","sai","khong_hop_ly","im_lang"];
const SV = ["dung_tl","sai_tl","bia_tl","khong_co_tl"];
addEventListener("keydown", e => {
  if (!/^[1-9]$/.test(e.key)) return;
  const mid = innerHeight/2;
  let best=null, dist=1e9;
  for (const c of document.querySelectorAll(".card:not(.done)")){
    const r=c.getBoundingClientRect(), d=Math.abs(r.top+r.height/2-mid);
    if (r.bottom>0 && r.top<innerHeight && d<dist){best=c;dist=d;}
  }
  if(!best) return;
  const id=best.dataset.id, rec=store[id]||{};
  const field = rec.handling===undefined ? "handling" : "source";
  const opts = field==="handling" ? HV : SV;
  const v = opts[+e.key - 1];
  if (v===undefined) return;   // phím ngoài dải của mục đang mở
  (store[id]=rec)[field]=v;
  LS.write(store);
  paint(best); progress();
  if (rec.source!==undefined) best.nextElementSibling?.scrollIntoView({behavior:"smooth",block:"center"});
});
document.getElementById("save").onclick = () => {
  const clean={}; for(const [k,v] of Object.entries(store))
    if(v.handling!==undefined&&v.source!==undefined) clean[k]={handling:v.handling,source:v.source};
  const t=document.getElementById("out");
  t.style.display="block"; t.value=JSON.stringify(clean,null,2);
  /* CUỘN TỚI Ô KẾT QUẢ.
     Thiếu dòng này thì nút "Xuất JSON" trông y như hỏng: ô kết quả nằm cuối
     luồng tài liệu, dưới toàn bộ thẻ bài, nên với 13 ca nó hiện ở khoảng
     6400px trong khi màn hình cao 720px — cách chỗ người dùng đang nhìn gần
     sáu nghìn pixel. Đo được, không phải phỏng đoán. Người chấm bấm xong,
     không thấy gì, và kết luận là không xuất được. */
  t.scrollIntoView({behavior:"smooth", block:"center"});
  t.focus(); t.select();
  const ok=document.getElementById("saved");
  try{
    navigator.clipboard.writeText(t.value);
    ok.textContent="đã chép vào clipboard — dán vào tệp là xong";
  }catch(_){
    ok.textContent="không chép tự động được — bôi đen ô dưới rồi Ctrl+C";
  }
  ok.style.display="inline";
};
document.getElementById("clear").onclick = () => {
  if(!confirm("Xoá toàn bộ điểm đã chấm?")) return;
  LS.clear(); location.reload();
};
</script>
`;

writeFileSync("bench/data/label-sheet.html", html);


console.log(`Đã ghi bench/data/label-sheet.html — ${picked.length} ca, thứ tự đã xáo (seed 42)`);
console.log(``);
console.log(`  1. npx tsx bench/serve-sheet.ts   → mở http://localhost:5055`);
console.log(`     (mở thẳng bằng file:// thì Chrome chặn localStorage và mất tiến độ khi F5)`);
console.log(`  2. Bấm chọn, hoặc bấm phím số ghi trên từng nút. Di chuột lên nút để xem giải thích.`);
console.log(`     Bảng KHÔNG hiện điểm máy — người chấm mù trước, máy chấm sau, rồi mới so.`);
if (only) {
  /* Bảng rút gọn xuất ra ĐÚNG những ca nó hiển thị. Lưu đè lên human-labels.json
     là xoá mất phần còn lại — nói thẳng ra ở đây, vì đó là một thao tác lưu duy
     nhất đứng giữa người dùng và việc mất cả một buổi tối bấm. */
  console.log(`  3. Bấm "Xuất JSON", lưu vào bench/data/relabel-${picked.length}.json`);
  console.log(`     ĐỪNG lưu đè human-labels.json — tệp này chỉ có ${picked.length} ca.`);
  console.log(`     Gộp vào bằng: npx tsx bench/merge-labels.ts bench/data/relabel-${picked.length}.json`);
} else {
  console.log(`  3. Bấm "Xuất JSON", lưu vào bench/data/human-labels.json`);
}
console.log(`  4. npx tsx bench/rag-eval.ts --judge      (giám khảo máy, CÙNG bộ luật)`);
console.log(`  5. npx tsx bench/judge-kappa.ts`);
