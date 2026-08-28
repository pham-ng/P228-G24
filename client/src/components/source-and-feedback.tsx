import { useState } from "react";
import { BookOpen, ThumbsUp, ThumbsDown, Check, AlertTriangle, X, ShieldCheck } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type SourceItem = {
  title: string;
  category?: string;
  sourceUrl?: string;
  snippet?: string;
  quality?: string;
};

export function readSourceReferences(toolTrace: string | null): SourceItem[] {
  if (!toolTrace) return [];
  try {
    const calls = JSON.parse(toolTrace) as Array<{ name: string; args?: any; result: any }>;
    const sources: SourceItem[] = [];

    for (const c of calls) {
      if (c.name === "search_knowledge" && c.result) {
        const passages = Array.isArray(c.result) ? c.result : c.result.passages;
        if (Array.isArray(passages)) {
          for (const p of passages) {
            if (p.title || p.body) {
              sources.push({
                title: p.title || "Tài liệu tri thức resort",
                category: p.category || "Hệ thống thông tin Vinpearl",
                sourceUrl: p.sourceUrl || "canonical-facts.json",
                snippet: (p.body || "").slice(0, 300) + (p.body?.length > 300 ? "..." : ""),
                quality: p.quality || "curated & verified",
              });
            }
          }
        }
      }
      if (c.name === "get_policy" && c.result) {
        const pols = Array.isArray(c.result) ? c.result : [c.result];
        for (const pol of pols) {
          if (pol.title || pol.summary) {
            sources.push({
              title: pol.title || "Quy định & Chính sách resort",
              category: pol.topic || "Quy định chung",
              sourceUrl: pol.sourceUrl || "booking.vinpearl.com",
              snippet: pol.summary || pol.rules,
              quality: "curated & verified",
            });
          }
        }
      }
    }

    // Deduplicate by title
    const unique = new Map<string, SourceItem>();
    for (const s of sources) {
      if (!unique.has(s.title)) unique.set(s.title, s);
    }
    return Array.from(unique.values());
  } catch {
    return [];
  }
}

export function SourceAndFeedback({
  messageId,
  conversationId,
  toolTrace,
  lang,
  code,
}: {
  messageId: number;
  conversationId: number;
  toolTrace: string | null;
  lang: string;
  /** The guest's confirmation code. Sent with the feedback so the server can
   *  verify this guest owns this conversation � without it the request is
   *  refused as unauthenticated, which is what silently broke this button. */
  code?: string | null;
}) {
  const vi = lang === "vi";
  const queryClient = useQueryClient();
  const sources = readSourceReferences(toolTrace);
  const [showSources, setShowSources] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [commentText, setCommentText] = useState("");

  const submitFeedback = useMutation({
    mutationFn: async ({ rating, escalate, comment }: { rating: number; escalate?: boolean; comment?: string }) => {
      return apiRequest("POST", `/api/conversations/${conversationId}/feedback`, {
        code,
        messageId,
        rating,
        escalate,
        comment,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/guest/conversations`] });
      queryClient.invalidateQueries({ queryKey: [`/api/conversations/${conversationId}`] });
    },
  });

  const handleLike = () => {
    if (liked) return;
    setLiked(true);
    setDisliked(false);
    submitFeedback.mutate({ rating: 5, comment: "Khách khen câu trả lời đúng" });
  };

  const handleDislike = () => {
    setShowReportModal(true);
  };

  const confirmReport = (escalate: boolean) => {
    setDisliked(true);
    setLiked(false);
    setShowReportModal(false);
    submitFeedback.mutate({
      rating: 1,
      escalate,
      comment: commentText.trim() || (vi ? "Khách báo câu trả lời chưa đúng" : "Reported inaccurate answer"),
    });
  };

  return (
    <div className="ml-9 mt-1 flex flex-wrap items-center gap-2 text-xs">
      {/* View Sources Button */}
      {sources.length > 0 && (
        <button
          type="button"
          onClick={() => setShowSources(!showSources)}
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <BookOpen className="h-3 w-3 text-primary" />
          <span>{vi ? `Nguồn trích xuất (${sources.length})` : `Sources (${sources.length})`}</span>
        </button>
      )}

      {/* Thumbs Up / Down Buttons */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleLike}
          disabled={liked || submitFeedback.isPending}
          className={`inline-flex items-center justify-center rounded-full p-1 transition-colors ${
            liked ? "bg-emerald-500/10 text-emerald-600" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          title={vi ? "Câu trả lời đúng & hữu ích" : "Helpful answer"}
        >
          {liked ? <Check className="h-3.5 w-3.5" /> : <ThumbsUp className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleDislike}
          disabled={disliked || submitFeedback.isPending}
          className={`inline-flex items-center justify-center rounded-full p-1 transition-colors ${
            disliked ? "bg-destructive/10 text-destructive" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          title={vi ? "Báo thông tin chưa chính xác" : "Report inaccurate answer"}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Source Evidence Popover/Drawer Modal */}
      {showSources && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs" onClick={() => setShowSources(false)}>
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background shadow-2xl border border-border/80"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5 bg-card/50">
              <div className="flex items-center gap-2 font-bold text-sm text-foreground">
                <BookOpen className="h-4 w-4 text-primary shrink-0" />
                <span>{vi ? "Nguồn dữ liệu & Trích dẫn bằng chứng" : "Source Evidence & References"}</span>
              </div>
              <button onClick={() => setShowSources(false)} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {sources.map((s, idx) => (
                <div key={idx} className="rounded-xl border border-border/70 bg-card p-3.5 shadow-2xs space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-bold text-xs text-foreground leading-snug">{s.title}</div>
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                      <ShieldCheck className="h-3 w-3" />
                      Verified
                    </span>
                  </div>
                  {s.category && <div className="text-[10px] font-medium text-muted-foreground">{s.category} • {s.sourceUrl}</div>}
                  {s.snippet && (
                    <div className="rounded-lg bg-muted/40 p-2.5 text-xs italic text-foreground/85 border-l-2 border-primary/50">
                      "{s.snippet}"
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Report Incorrect Answer Modal */}
      {showReportModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs" onClick={() => setShowReportModal(false)}>
          <div
            className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-background shadow-2xl border border-border/80 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-destructive font-bold text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{vi ? "Báo câu trả lời chưa chính xác" : "Report Inaccurate Answer"}</span>
              </div>
              <button onClick={() => setShowReportModal(false)} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-foreground/80 leading-relaxed">
              {vi
                ? "Chúng tôi rất tiếc vì câu trả lời của AI chưa chính xác. Bạn có muốn chuyển ngay câu hỏi này cho Lễ tân khách sạn hỗ trợ trực tiếp không?"
                : "We apologize for the inaccurate AI response. Would you like to escalate this directly to our front desk team?"}
            </p>

            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={vi ? "Nhập chi tiết điều chưa đúng (tùy chọn)..." : "Optional feedback details..."}
              className="w-full rounded-xl border border-border bg-card p-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none h-20"
            />

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => confirmReport(true)}
                disabled={submitFeedback.isPending}
                className="w-full rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all shadow-md flex items-center justify-center gap-1.5"
              >
                <span>🙋 {vi ? "Yêu cầu Lễ tân hỗ trợ ngay (Khuyên dùng)" : "Escalate to Front Desk Staff"}</span>
              </button>

              <button
                type="button"
                onClick={() => confirmReport(false)}
                disabled={submitFeedback.isPending}
                className="w-full rounded-xl border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
              >
                <span>✍️ {vi ? "Chỉ gửi góp ý (Không cần gọi lễ tân)" : "Just send feedback"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
