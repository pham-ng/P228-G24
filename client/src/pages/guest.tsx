import { useEffect, useMemo, useRef, useState, memo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Loader2, SendHorizonal, ShieldCheck, UserRound } from "lucide-react";
import { AureaMark } from "@/components/logo";
import { MarkdownBody } from "@/components/markdown-body";
import { PackageActions, readRecommendation } from "@/components/package-actions";
import { DiningActions, readDiningReference } from "@/components/dining-actions";
import { RoomActions, readRoomReference } from "@/components/room-actions";
import { ServiceActions, readServiceReference } from "@/components/service-actions";
import { SourceAndFeedback } from "@/components/source-and-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { clock } from "@/lib/format";
import { LANG_LABELS, type ConversationDetail, type GuestKey, type Hotel } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROOM_QUICK_CHIPS: Record<string, string[]> = {
  vi: [
    "🛏️ Deluxe giường đôi",
    "🛏️ Deluxe 2 giường đơn",
    "🏨 Grand Deluxe giường đôi",
    "🌟 Executive Suite",
    "🏡 Villa 2 phòng ngủ",
    "🌊 Villa 3 phòng ngủ hướng biển",
  ],
  en: [
    "🛏️ Deluxe Double Bed",
    "🛏️ Deluxe Twin Bed",
    "🏨 Grand Deluxe King",
    "🌟 Executive Suite",
    "🏡 2-Bedroom Villa",
  ],
};

const PROMPTS: Record<string, string[]> = {
  en: [
    "🛏️ Room types & pricing",
    "🍽️ Restaurant menus & pricing",
    "💆 Spa treatments & hours",
    "🚪 Late check-out pricing",
    "🚠 Cable car schedule",
  ],
  vi: [
    "🛏️ Các hạng phòng & giá phòng",
    "🍽️ Menu nhà hàng",
    "🍲 Nhà hàng Lotus",
    "🥩 Nhà hàng Jasmine",
    "🥢 Nhà hàng Bách Giai",
    "💆 Dịch vụ Spa & giờ mở cửa",
    "🚪 Phí trả phòng muộn",
    "🚠 Giờ chạy cáp treo",
  ],
  ko: [
    "🛏️ 객실 종류 및 요금",
    "🍽️ 레스토랑 메뉴 및 가격",
    "💆 스파 트리트먼트 및 운영시간",
    "🚪 레이트 체크아웃 안내",
  ],
  zh: ["🛏️ 房型与价格", "🍽️ 餐厅菜单与价格", "💆 水疗 Spa 价格", "🚪 延迟退房费用"],
  ru: ["🛏️ Номера и цены", "🍽️ Меню ресторанов", "💆 Услуги спа", "🚪 Поздний выезд"],
  ja: ["🛏️ 客室と料金", "🍽️ レストランメニューと料金", "💆 スパの営業時間と料金", "🚪 レイトチェックアウト費用"],
};

const Bubble = memo(function Bubble({
  role,
  body,
  time,
  author,
}: {
  role: string;
  body: string;
  time: string;
  author?: string | null;
}) {
  if (role === "system") {
    return (
      <div className="my-3 text-center text-xs text-muted-foreground" data-testid="message-system">
        {body}
      </div>
    );
  }
  const mine = role === "guest";
  return (
    <div className={cn("flex gap-2.5", mine ? "justify-end" : "justify-start")}>
      {!mine && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          {role === "staff" ? <UserRound className="h-3.5 w-3.5" /> : <AureaMark className="h-4 w-4" />}
        </div>
      )}
      <div className={cn("max-w-[82%] sm:max-w-[70%]", mine && "text-right")}>
        {!mine && (
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {role === "staff" ? `${author ?? "Front desk"} · Front desk` : "Aurea Concierge"}
          </div>
        )}
        <div
          data-testid={`message-${role}`}
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-left text-sm leading-relaxed",
            mine
              ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
              : role === "staff"
                ? "rounded-bl-sm border border-border bg-secondary"
                : "rounded-bl-sm border border-card-border bg-card",
          )}
        >
          {mine ? body : <MarkdownBody text={body} />}
        </div>
        <div className="mt-1 px-1 text-[10px] text-muted-foreground">{time}</div>
      </div>
    </div>
  );
});

function KeyPicker({ onPick }: { onPick: (code: string) => void }) {
  const { data: keys } = useQuery<GuestKey[]>({ queryKey: ["/api/guest/keys"] });
  const { data: hotel } = useQuery<Hotel>({ queryKey: ["/api/hotel"] });
  const [code, setCode] = useState("");
  const inHouse = (keys ?? []).filter((k) => k.status === "in_house");
  const others = (keys ?? []).filter((k) => k.status !== "in_house");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-12">
      <AureaMark className="h-10 w-10 text-primary" />
      <h1 className="mt-5 font-serif text-2xl font-semibold tracking-tight">
        {hotel?.name ?? "Aurea"}
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Your concierge answers in your language, around the clock — and can actually act on
        requests: book a table, order to the room, arrange a late departure, call engineering.
      </p>

      <form
        className="mt-7 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onPick(code.trim().toUpperCase());
        }}
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Confirmation code, e.g. VPNT-2M77VD"
          className="font-mono"
          data-testid="input-code"
        />
        <Button type="submit" data-testid="button-open-chat">
          Open <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </form>

      <div className="mt-8">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          In house now
        </div>
        <div className="mt-2 grid gap-1.5">
          {inHouse.map((k) => (
            <button
              key={k.confirmationCode}
              onClick={() => onPick(k.confirmationCode)}
              data-testid={`key-${k.confirmationCode}`}
              className="hover-elevate flex items-center gap-3 rounded-md border border-card-border bg-card px-3 py-2.5 text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium">{k.guestName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  Room {k.room} · {LANG_LABELS[k.lang] ?? k.lang}
                  {k.vipTier !== "none" && ` · ${k.vipTier}`}
                </div>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                {k.confirmationCode}
              </span>
            </button>
          ))}
          {inHouse.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              Loading reservations…
            </div>
          )}
        </div>
        {others.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Arriving & past stays ({others.length})
            </summary>
            <div className="mt-2 grid gap-1.5">
              {others.map((k) => (
                <button
                  key={k.confirmationCode}
                  onClick={() => onPick(k.confirmationCode)}
                  data-testid={`key-${k.confirmationCode}`}
                  className="hover-elevate flex items-center gap-3 rounded-md border border-card-border bg-card px-3 py-2 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{k.guestName}</div>
                    <div className="text-xs text-muted-foreground">
                      {k.status.replace("_", " ")} · {k.checkIn} → {k.checkOut}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {k.confirmationCode}
                  </span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      <Link
        href="/staff"
        className="mt-10 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        data-testid="link-staff"
      >
        <ShieldCheck className="h-3.5 w-3.5" /> Hotel team sign-in
      </Link>
    </div>
  );
}

/**
 * What the kiosk is actually doing while the guest waits.
 *
 * Every line here has to be TRUE of the turn in progress. The previous set
 * claimed "Tính toán ưu đãi thành viên…" / "Applying member entitlements…" on
 * every single turn — it showed while answering "mấy giờ ăn sáng?", where no
 * entitlement is read and no member price exists. A progress line that
 * describes work the system is not doing is a small lie the guest can catch,
 * and it is the kind that makes them distrust the parts that are true.
 *
 * The three that remain map to real stages of the offline pipeline: routing
 * (classifyLocal), retrieval (hybridSearch), generation (one model call).
 *
 * All six production languages, because a Korean or Russian guest waiting
 * eight seconds at an English spinner is the same gap as the answer itself
 * coming back in the wrong language — the kiosk stops feeling like it is
 * speaking to them.
 */
const REASONING_STEPS: Record<string, string[]> = {
  vi: ["Đang phân tích yêu cầu...", "Đang tìm trong kho tri thức...", "Đang soạn câu trả lời..."],
  en: ["Analysing your request...", "Searching the knowledge base...", "Writing your answer..."],
  ko: ["요청을 분석하고 있습니다...", "자료를 검색하고 있습니다...", "답변을 작성하고 있습니다..."],
  ja: ["ご質問を確認しています...", "資料を検索しています...", "回答を作成しています..."],
  zh: ["正在分析您的问题...", "正在检索资料...", "正在撰写回复..."],
  ru: ["Анализируем ваш запрос...", "Ищем в базе знаний...", "Готовим ответ..."],
};

function ReasoningIndicator({ lang }: { lang: string }) {
  const steps = REASONING_STEPS[lang] ?? REASONING_STEPS.en;
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    }, 2000); // Change step every 2 seconds
    return () => clearInterval(interval);
  }, [steps]);

  return <span className="animate-pulse">{steps[stepIndex]}</span>;
}

export default function GuestPage() {
  // Deep link support: #/?code=AUR-8F31KQ opens straight into that guest's thread.
  const initialCode = (() => {
    const hash = window.location.hash.replace(/^#/, "");
    const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    return new URLSearchParams(q).get("code");
  })();
  const [code, setCode] = useState<string | null>(initialCode);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);

  const session = useQuery<ConversationDetail & { conversationId: number }>({
    queryKey: ["guest-session", code],
    enabled: !!code,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/guest/session", { code });
      return res.json();
    },
  });

  const conversationId = session.data?.conversationId;

  // Poll so a staff takeover reply lands in the guest thread without a refresh.
  const live = useQuery<ConversationDetail>({
    queryKey: [`/api/conversations/${conversationId}?code=${encodeURIComponent(code ?? "")}`],
    enabled: !!conversationId,
    refetchInterval: 5000,
  });

  const detail = live.data ?? session.data;

  const send = useMutation({
    mutationFn: async (body: string) => {
      const res = await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        from: "guest",
        body,
      });
      return res.json() as Promise<ConversationDetail>;
    },
    onSuccess: (data) => {
      qc.setQueryData([`/api/conversations/${conversationId}?code=${encodeURIComponent(code ?? "")}`], data);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length, send.isPending]);

  /* Whether the GUEST has shown interest in rooms — their own words only.
   *
   * This used to read the last message in the thread, which is the AI's reply,
   * with a boundary-less alternation that included bare "phong", "gia" and
   * "giá". Almost every answer this concierge writes contains one of them:
   * "Wi-Fi miễn phí trong toàn bộ phòng, biệt thự…" matched "phòng" and
   * unfolded five room-shopping chips under a wifi answer. "gia" also matched
   * inside "Bách Giai", "gia đình" and "giai đoạn", so a restaurant question
   * did it too.
   *
   * Rooms are the thing the guest asks about, not the thing our own sentence
   * happens to mention — so this reads the draft they are typing and their
   * own last message, and matches on words that only appear when someone is
   * shopping for a room. */
  const roomRelated = useMemo(() => {
    const lastGuestText =
      [...(detail?.messages ?? [])].reverse().find((m) => m.role === "guest")?.body ?? "";
    const text = `${draft} ${lastGuestText}`.toLowerCase();
    return /(?:^|[^\p{L}])(?:deluxe|delu|villa|suite|hạng phòng|hang phong|loại phòng|loai phong|đặt phòng|dat phong|room type|room rate|book a room)(?:[^\p{L}]|$)/u.test(
      text,
    );
  }, [draft, detail?.messages]);

  const prompts = useMemo(() => {
    const lang = detail?.guest.lang ?? "en";
    const base = PROMPTS[lang] ?? PROMPTS.en;
    /* No English fallback here. ROOM_QUICK_CHIPS only covers vi and en, and
       falling back handed a Russian guest "🛏️ Deluxe Double Bed" sitting next
       to "🛏️ Номера и цены" in the same row. A chip the guest cannot read is
       worse than no chip — `base` already offers rooms in their language. */
    const roomChips = ROOM_QUICK_CHIPS[lang];
    if (roomRelated && roomChips) {
      return Array.from(new Set([...roomChips, ...base]));
    }
    return base;
  }, [detail?.guest.lang, roomRelated]);

  if (!code) return <KeyPicker onPick={setCode} />;

  if (session.isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          We couldn't find a reservation for that code.
        </p>
        <Button variant="outline" onClick={() => setCode(null)} data-testid="button-back">
          Try another code
        </Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const human = detail.conversation.mode === "human";
  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(body);
  };

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <AureaMark className="h-7 w-7 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-sm font-semibold">Aurea Concierge</div>
          <div className="truncate text-xs text-muted-foreground">
            {detail.guest.name} · Room {detail.room?.number ?? "—"} ·{" "}
            {human ? "Front desk is with you" : "AI concierge · replies in seconds"}
          </div>
        </div>
        <button
          onClick={() => setCode(null)}
          className="text-xs text-muted-foreground hover:text-foreground"
          data-testid="button-switch-guest"
        >
          Switch
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5" data-testid="thread">
        {detail.messages.map((m, i) => {
          /* Follow-up taps belong to the concierge's latest turn only: leaving
             chips live on older messages lets a guest answer a question that has
             already moved on. */
          const isLastAi = m.role === "ai" && i === detail.messages.length - 1;
          const rec = isLastAi ? readRecommendation(m.toolTrace) : null;
          const dining = m.role === "ai" ? readDiningReference(m.toolTrace) : [];
          const rooms = m.role === "ai" ? readRoomReference(m.toolTrace) : [];
          const svcGroups = m.role === "ai" ? readServiceReference(m.toolTrace) : [];
          return (
            <div key={m.id}>
              <Bubble role={m.role} body={m.body} author={m.authorName} time={clock(m.createdAt)} />
              {rec && (
                <div className="ml-9 mt-1">
                  <PackageActions
                    rec={rec}
                    lang={detail.guest.lang}
                    disabled={send.isPending}
                    onSend={(text) => send.mutate(text)}
                  />
                </div>
              )}
              {dining.length > 0 && (
                <div className="ml-9 mt-1">
                  <DiningActions venues={dining} lang={detail.guest.lang} />
                </div>
              )}
              {rooms.length > 0 && (
                <div className="ml-9 mt-1">
                  <RoomActions rooms={rooms} lang={detail.guest.lang} onSend={(text) => send.mutate(text)} />
                </div>
              )}
              {svcGroups.length > 0 && (
                <div className="ml-9 mt-1">
                  <ServiceActions groups={svcGroups} lang={detail.guest.lang} />
                </div>
              )}
              {m.role === "ai" && (
                <SourceAndFeedback
                  messageId={m.id}
                  conversationId={detail.conversation.id}
                  code={code}
                  toolTrace={m.toolTrace}
                  lang={detail.guest.lang}
                />
              )}
            </div>
          );
        })}
        {send.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="typing">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {human ? "Sending to the front desk…" : <ReasoningIndicator lang={detail?.guest.lang ?? "en"} />}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Dynamic Quick Action Chips — Always visible so the guest doesn't have to type everything */}
      <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => send.mutate(p)}
            disabled={send.isPending}
            data-testid="prompt-chip"
            className="hover-elevate rounded-full border border-border bg-card px-3 py-1 text-xs transition-colors hover:bg-primary/10 hover:border-primary/40 disabled:opacity-50"
          >
            {p}
          </button>
        ))}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask anything, or tell us what you need…"
            className="max-h-32 min-h-[42px] resize-none"
            data-testid="input-message"
          />
          <Button
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
            size="icon"
            className="h-[42px] w-[42px] shrink-0"
            data-testid="button-send"
          >
            <SendHorizonal className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          Requests are logged to the hotel's operations board. A human joins whenever it matters.
        </p>
      </div>
    </div>
  );
}
