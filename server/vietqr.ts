/**
 * VietQR payload construction — the NAPAS profile of the EMVCo QR standard.
 *
 * WHY THIS IS NOT AN INTEGRATION. VietQR is a STRING FORMAT, not an API. There
 * is no merchant contract, no credentials, no gateway and no callback: the code
 * encodes a bank BIN, an account number, an amount and a description, the guest
 * scans it with whatever banking app they already have, and the money moves
 * bank-to-bank straight into the hotel's account. That is why it was the one
 * payment feature worth building before the product has a public URL.
 *
 * WHAT IT CANNOT DO. Nothing tells the hotel the transfer happened. There is no
 * webhook to receive, because nobody is being asked to send one. The desk sees
 * the money in their banking app and records it with the "Ghi nhận thu" button,
 * which is how most small Vietnamese hotels already work.
 *
 * FORMAT, as EMVCo tag-length-value. Every value is ASCII; length is two digits
 * and counts CHARACTERS, so any non-ASCII in a name or description would make
 * the declared length disagree with what a scanner reads — see `ascii()`.
 *
 *   00 Payload Format Indicator          "01"
 *   01 Point of Initiation               "11" static (reusable) | "12" dynamic (one-off)
 *   38 Merchant Account Information (NAPAS)
 *      00 GUID                           "A000000727"
 *      01 Beneficiary
 *         00 Acquirer ID                 6-digit bank BIN
 *         01 Account number
 *      02 Service code                   "QRIBFTTA" to an account
 *   53 Transaction Currency              "704" (VND)
 *   54 Transaction Amount                optional; omitted makes it open-amount
 *   58 Country Code                      "VN"
 *   62 Additional Data
 *      08 Purpose of transaction
 *   63 CRC                               CRC-16/CCITT-FALSE over everything incl. "6304"
 *
 * VERIFICATION HONESTY: the CRC is checked against the standard CRC-16/CCITT
 * -FALSE vector in `test/vietqr.test.ts`, and the payload is parsed back to
 * confirm every declared length matches. What cannot be verified from here is
 * that a real banking app accepts it — that needs a phone and one scan, and it
 * must be done before this is shown to a guest. A single wrong byte fails
 * silently: the app simply does not recognise the code.
 */

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** One tag-length-value field. Length is two digits, so a value must be < 100. */
function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new Error(`VietQR field ${tag} is too long (${value.length} chars).`);
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

/**
 * Strip a string down to what a QR scanner will read back identically.
 *
 * The length prefix counts characters. Vietnamese diacritics survive a JS
 * string fine but not every scanner decodes them the same way, and a mismatch
 * between the declared length and the decoded length breaks the whole payload
 * rather than one field. Diacritics are folded rather than dropped so
 * "Nguyễn Thị Lan" stays readable as "Nguyen Thi Lan" on the bank statement.
 */
export function ascii(s: string, max: number): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type VietQrInput = {
  /** 6-digit NAPAS bank identifier, e.g. Vietcombank 970436. */
  bankBin: string;
  accountNumber: string;
  /** Omit for an open-amount code the guest fills in themselves. */
  amount?: number;
  /** Shown to the guest in their banking app and on the hotel's statement. */
  description?: string;
};

export function buildVietQrPayload(input: VietQrInput): string {
  const bin = String(input.bankBin || "").replace(/\D/g, "");
  const acc = String(input.accountNumber || "").replace(/[^A-Za-z0-9]/g, "");
  if (bin.length !== 6) throw new Error(`bankBin must be 6 digits, got "${input.bankBin}".`);
  if (!acc) throw new Error("accountNumber is required.");

  const beneficiary = tlv("00", bin) + tlv("01", acc);
  const merchantAccount =
    tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");

  /* A code carrying an amount is single-purpose, so it is marked dynamic (12).
     An open-amount code is reusable and marked static (11). Getting this wrong
     does not break the scan but does mislead apps that cache static codes. */
  const hasAmount = Number.isFinite(input.amount) && (input.amount as number) > 0;

  let payload =
    tlv("00", "01") +
    tlv("01", hasAmount ? "12" : "11") +
    tlv("38", merchantAccount) +
    tlv("53", "704");

  /* VND has no minor units, so the amount is a whole number with no decimal
     point — sending "520000.00" is a common way to produce a code that scans
     but transfers the wrong figure. */
  if (hasAmount) payload += tlv("54", String(Math.round(input.amount as number)));

  payload += tlv("58", "VN");

  const purpose = ascii(input.description ?? "", 99);
  if (purpose) payload += tlv("62", tlv("08", purpose));

  /* The CRC covers the tag and length of the CRC field itself. */
  const withCrcHeader = `${payload}6304`;
  return withCrcHeader + crc16(withCrcHeader);
}

/** Parse a payload back into fields — used by the tests to prove the lengths. */
export function parseTlv(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) throw new Error(`bad length at ${i}`);
    const value = payload.slice(i + 4, i + 4 + len);
    if (value.length !== len) throw new Error(`field ${tag} declares ${len} but has ${value.length}`);
    out[tag] = value;
    i += 4 + len;
  }
  if (i !== payload.length) throw new Error(`trailing bytes at ${i}`);
  return out;
}

/** True when the payload's own CRC matches its contents. */
export function verifyCrc(payload: string): boolean {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  return crc16(body) === payload.slice(-4).toUpperCase();
}
