/**
 * Gộp một lượt chấm lại vào bộ nhãn đã có.
 *
 *   npx tsx bench/merge-labels.ts bench/data/relabel-13.json
 *   npx tsx bench/merge-labels.ts bench/data/relabel-13.json --dry
 *
 * Vì sao cần: bảng chấm rút gọn (`--ids-file`) xuất ra ĐÚNG những ca nó hiển
 * thị. Lưu thẳng tệp đó đè lên `human-labels.json` là mất 88 ca đã bấm — một
 * buổi tối đi tong vì một thao tác lưu. Script này chỉ ghi đè đúng các khoá có
 * trong tệp mới, giữ nguyên phần còn lại, và in ra chính xác cái gì đổi.
 *
 * Luôn ghi một bản sao lưu trước khi đụng vào tệp gốc.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";

type Label = { handling?: string; source?: string };

const incoming = process.argv[2];
const dry = process.argv.includes("--dry");
if (!incoming) {
  console.error("Dùng: npx tsx bench/merge-labels.ts <tệp-nhãn-mới.json> [--dry]");
  process.exit(2);
}

const base = join(process.cwd(), "bench", "data", "human-labels.json");
if (!existsSync(base)) {
  console.error(`Chưa có ${base} — chưa có gì để gộp vào.`);
  process.exit(2);
}

const cur = JSON.parse(readFileSync(base, "utf8")) as Record<string, Label>;
const nw = JSON.parse(readFileSync(incoming, "utf8")) as Record<string, Label>;

const changed: string[] = [];
const added: string[] = [];
for (const [id, v] of Object.entries(nw)) {
  const old = cur[id];
  if (!old) {
    added.push(id);
  } else if (old.handling !== v.handling || old.source !== v.source) {
    changed.push(`${id}: ${old.handling}/${old.source} → ${v.handling}/${v.source}`);
  }
}

console.log(`đang có ${Object.keys(cur).length} ca · tệp mới ${Object.keys(nw).length} ca`);
console.log(`  đổi nhãn : ${changed.length}`);
for (const c of changed) console.log(`    ${c}`);
console.log(`  thêm mới : ${added.length}${added.length ? " — " + added.join(", ") : ""}`);

if (dry) {
  console.log("\n--dry: không ghi gì.");
  process.exit(0);
}

copyFileSync(base, base.replace(/\.json$/, `.bak.json`));
writeFileSync(base, JSON.stringify({ ...cur, ...nw }, null, 2) + "\n");
console.log(`\nĐã gộp → ${Object.keys({ ...cur, ...nw }).length} ca. Bản cũ lưu ở human-labels.bak.json`);
