/** Confirms every reservation code the benchmark's gold set relies on exists in
 *  the database it will run against, and prints the balances so the expected
 *  figures can be re-verified instead of trusted. Run: node benchcheck.ts */
import Database from "better-sqlite3";
const db = new Database(process.env.DB_FILE || "data.db", { readonly: true });
const rows = db.prepare("select id, confirmation_code as code from reservations").all() as { id: number; code: string }[];
console.log("codes in DB:", rows.map((r) => r.code).join(", "));
const gold = ["VPNT-1D40TG","VPNT-6B44LN","VPNT-9K52JH","VPNT-4Q18ZM","VPNT-5T09WB","VPNT-2M77VD","VPNT-7H23PC","VPNT-5K18QA"];
const have = new Set(rows.map((r) => r.code));
const missing = gold.filter((g) => !have.has(g));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all gold codes present");
for (const r of rows) {
  const t = db.prepare("select sum(amount) as s from folio_charges where reservation_id = ? and voided_at is null").get(r.id) as { s: number | null };
  console.log(`  ${r.code}  folio sum = ${t.s ?? 0}`);
}
