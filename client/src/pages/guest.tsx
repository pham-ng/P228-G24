import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Loader2, SendHorizonal, ShieldCheck, UserRound } from "lucide-react";
import { AureaMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { clock } from "@/lib/format";
import { LANG_LABELS, type ConversationDetail, type GuestKey, type Hotel } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROMPTS: Record<string, string[]> = {
  en: [
    "What time is breakfast and where is it served?",
    "How much is the cable car and when does it run?",
    "Book the Lotus dinner buffet for two tonight",
    "Can I have late check-out tomorrow?",
  ],
  vi: [
    "Bữa sáng mấy giờ và ở đâu ạ?",
    "Giá vé cáp treo và giờ chạy thế nào?",
    "Đặt buffet tối Lotus cho 2 người tối nay",
    "Tôi muốn trả phòng muộn ngày mai",
  ],
  ko: [
    "조식은 몇 시에 어디에서 제공되나요?",
    "아쿠아필드 사우나 운영 시간을 알려주세요",
    "오늘 저녁 2명 뷔페 예약해 주세요",
  ],
  zh: ["早餐几点在哪里？", "缆车票价和运营时间是多少？", "今晚帮我订两位晚餐"],
  ru: ["Во сколько завтрак и где он подаётся?", "Сколько стоит фуникулёр?", "Забронируйте ужин на двоих"],
  ja: ["朝食は何時からですか？", "ロープウェイの料金と運行時間は？", "今夜2名で夕食を予約したいです"],
};

function Bubble({
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
            "whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-left text-sm leading-relaxed",
            mine
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : role === "staff"
                ? "rounded-bl-sm border border-border bg-secondary"
                : "rounded-bl-sm border border-card-border bg-card",
          )}
        >
          {body}
        </div>
        <div className="mt-1 px-1 text-[10px] text-muted-foreground">{time}</div>
      </div>
    </div>
  );
}

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
    queryKey: [`/api/conversations/${conversationId}`],
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
      qc.setQueryData([`/api/conversations/${conversationId}`], data);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length, send.isPending]);

  const prompts = useMemo(() => {
    const lang = detail?.guest.lang ?? "en";
    return PROMPTS[lang] ?? PROMPTS.en;
  }, [detail?.guest.lang]);

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
        {detail.messages.map((m) => (
          <Bubble
            key={m.id}
            role={m.role}
            body={m.body}
            author={m.authorName}
            time={clock(m.createdAt)}
          />
        ))}
        {send.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="typing">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {human ? "Sending to the front desk…" : "Concierge is checking with the hotel systems…"}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {detail.messages.length < 3 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
          {prompts.map((p) => (
            <button
              key={p}
              onClick={() => send.mutate(p)}
              disabled={send.isPending}
              data-testid="prompt-chip"
              className="hover-elevate rounded-full border border-border bg-card px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {p}
            </button>
          ))}
        </div>
      )}

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
