/**
 * Which guardrail layers are switched on, and which can never be switched off.
 *
 * The point of a toggle is a demo: turn a layer off, send the attack, watch it
 * land, turn it back on, watch it stop. That is the most convincing thing a
 * security feature can do in front of a customer, and it is impossible to show
 * if the layers are compiled in.
 *
 * But a toggle is also a hole. So the set of switchable layers is closed and
 * deliberately small, and the LIFE-SAFETY PATH IS NOT IN IT. A medical
 * emergency, a fire, an unattended child near water — those escalate whatever
 * this file says. There is no configuration, no environment variable and no API
 * call that turns them off, because the cost of someone leaving that switch
 * flipped after a demo is measured in a person, not in a support ticket.
 *
 * Persisted in `app_settings`, which until now was an empty table with a write
 * path nobody called.
 */
import { storage } from "./storage";

export type GuardLayer =
  | "injection"
  | "untrusted_content"
  | "card_redaction"
  | "third_party_pii"
  /** Weapons and requests for sexual services. OFF by default — see DEFAULT_OFF. */
  | "restricted_requests";

export type GuardLayerInfo = {
  key: GuardLayer;
  label: string;
  description: string;
  enabled: boolean;
};

const SETTING_PREFIX = "guardrail.";

/** Defaults are ON unless listed in DEFAULT_OFF below. */
const LAYERS: { key: GuardLayer; label: string; description: string }[] = [
  {
    key: "injection",
    label: "Chống prompt injection",
    description:
      "Chuẩn hoá Unicode (NFKC, bỏ ký tự vô hình) rồi đối chiếu mẫu. Tắt lớp này thì 7/10 biến thể né tránh đi lọt — đo bằng bench/injection-bypass-probe.ts.",
  },
  {
    key: "untrusted_content",
    label: "Tài liệu là dữ liệu, không phải mệnh lệnh",
    description:
      "Gỡ câu mang hình thức ra lệnh khỏi tài liệu được truy xuất trước khi đưa vào prompt. Chống injection gián tiếp qua kho tri thức.",
  },
  {
    key: "card_redaction",
    label: "Xoá số thẻ",
    description: "Kiểm Luhn ở cả tin nhắn vào và câu trả lời ra, nên số thẻ không nằm lại trong lịch sử hội thoại.",
  },
  {
    key: "third_party_pii",
    label: "Chặn hỏi thông tin khách khác",
    description: "Phát hiện yêu cầu lấy số phòng, hoá đơn, giấy tờ của người khác và chuyển sang người thật.",
  },
  {
    key: "restricted_requests",
    label: "Từ chối vũ khí và dịch vụ người lớn",
    description:
      "MẶC ĐỊNH TẮT. Khách gần như không bao giờ hỏi những thứ này, và mỗi luật cứng thêm vào là một khả năng chặn nhầm câu bình thường — đo trên 403 ca thật, hai mẫu đầu tiên đã chặn nhầm 4 câu, trong đó có một khách bị thương. Tắt thì các yêu cầu này đi thẳng tới mô hình. Ma tuý KHÔNG nằm trong công tắc này: nó vốn đã được chặn từ trước.",
  },
];

/**
 * Layers that start OFF.
 *
 * Everything else defaults on, because a guard is only off when somebody turned
 * it off. This one is the exception: it was added on my initiative, the owner
 * judged the risk of blocking ordinary guests higher than the risk it prevents,
 * and that is a product call rather than an engineering one. The code and its
 * tests stay so the decision is one click, not a rewrite.
 */
const DEFAULT_OFF = new Set<GuardLayer>(["restricted_requests"]);

/**
 * Never switchable, listed here so the UI can show them as permanently on
 * rather than leaving a customer to wonder whether they were forgotten.
 */
export const ALWAYS_ON = [
  { key: "medical_emergency", label: "Cấp cứu y tế", description: "Không thể tắt. Escalate ngay, bỏ qua mọi cấu hình." },
  { key: "safety_threat", label: "Đe doạ an toàn", description: "Không thể tắt. Cháy, đột nhập, trẻ em không người lớn." },
];

/* One read per turn would hit SQLite on the request path for no reason — the
   value changes when a human clicks a switch, which is rare. Cached, and the
   cache is dropped on write. */
let cache: Map<GuardLayer, boolean> | null = null;

function load(): Map<GuardLayer, boolean> {
  if (cache) return cache;
  const m = new Map<GuardLayer, boolean>();
  for (const l of LAYERS) {
    let v: string | null = null;
    try {
      v = storage.getSetting(`${SETTING_PREFIX}${l.key}`) ?? null;
    } catch {
      /* A settings table that cannot be read must not disable a guard. */
      v = null;
    }
    m.set(l.key, v === null ? !DEFAULT_OFF.has(l.key) : v !== "0" && v !== "false");
  }
  cache = m;
  return m;
}

/** Is this layer active? Unknown keys are treated as ON — failing closed. */
export function guardEnabled(layer: GuardLayer): boolean {
  return load().get(layer) ?? !DEFAULT_OFF.has(layer);
}

export function listGuardLayers(): GuardLayerInfo[] {
  const m = load();
  return LAYERS.map((l) => ({ ...l, enabled: m.get(l.key) ?? !DEFAULT_OFF.has(l.key) }));
}

export function setGuardLayer(layer: GuardLayer, enabled: boolean): GuardLayerInfo[] {
  if (!LAYERS.some((l) => l.key === layer)) throw new Error(`unknown guardrail layer: ${layer}`);
  storage.setSetting(`${SETTING_PREFIX}${layer}`, enabled ? "1" : "0");
  cache = null;
  /* Loud, and permanent in the audit log — a disabled guard is a state somebody
     has to be able to discover later, especially the "we turned it off for the
     demo and forgot" case this switch exists to enable. */
  console.warn(`[guard] layer "${layer}" ${enabled ? "ENABLED" : "DISABLED"}`);
  return listGuardLayers();
}
