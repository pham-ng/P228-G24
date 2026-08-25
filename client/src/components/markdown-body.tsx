import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Helper function to inspect child nodes and highlight currency patterns, time ranges, and badges nicely
 */
function renderEnhancedChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    // Highlighting currency (e.g. 2.500.000 ₫, 1.500.000 VND)
    const currencyRegex = /(\b\d{1,3}(?:\.\d{3})+\s*(?:₫|VND|VNĐ)\b)/g;
    // Highlighting time ranges (e.g. 10:30–14:30, 07:00 – 21:00)
    const timeRegex = /(\b\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}\b)/g;

    const parts = children.split(/(\b\d{1,3}(?:\.\d{3})+\s*(?:₫|VND|VNĐ)\b|\b\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}\b)/g);
    if (parts.length > 1) {
      return parts.map((part, i) => {
        if (currencyRegex.test(part)) {
          return (
            <span key={i} className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-[0.88em] font-semibold text-amber-700 dark:text-amber-300 border border-amber-500/20 mx-0.5">
              {part}
            </span>
          );
        }
        if (timeRegex.test(part)) {
          return (
            <span key={i} className="inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.88em] font-medium text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 mx-0.5">
              ⏱ {part}
            </span>
          );
        }
        return part;
      });
    }
  }
  return children;
}

function RoomListItem({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  
  // Extract text to check for room types
  let text = "";
  if (Array.isArray(children)) {
    text = children.map(c => typeof c === 'string' ? c : (c as any)?.props?.children ?? "").join("");
  } else if (typeof children === "string") {
    text = children;
  }
  
  /* Images come ONLY from the server's own [IMAGES: ...] tag (real DB paths
   * the model was instructed to echo back — see server/dining.ts,
   * server/catalogue.ts, server/agent.ts). A prior per-name keyword-guess
   * fallback lived here for when the model omitted the tag; it was removed
   * after being found to serve a stale/wrong path for Bách Giai
   * (/dining/bach-giai/1.jpg — the real file is 1.webp, a 404) and to have
   * no coverage at all for any room/dish/venue added after it was written.
   * No inline image is strictly better than a broken or mismatched one. */
  let images: string[] = [];
  const imageMatch = text.match(/\[IMAGES:\s*([^\]]+)\]/i);
  if (imageMatch) {
    images = imageMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  }

  const hasImages = images.length > 0;
  
  // Clean children to hide the [IMAGES: ...] tag
  const cleanChildren = (nodes: ReactNode): ReactNode => {
    if (typeof nodes === 'string') {
      return nodes.replace(/\[IMAGES:\s*[^\]]+\]/gi, '');
    }
    if (Array.isArray(nodes)) {
      return nodes.map(n => cleanChildren(n));
    }
    return nodes;
  };

  const displayChildren = cleanChildren(children);

  return (
    <>
      <li className="group relative flex flex-col gap-2.5 rounded-lg border border-border/50 bg-background/60 p-2.5 text-sm transition-all hover:bg-background/90 hover:border-border hover:shadow-sm">
        <div className="flex items-start gap-2.5 cursor-pointer w-full" onClick={() => hasImages && setExpanded(!expanded)}>
          <span className="mt-1 flex h-2 w-2 shrink-0 rounded-full bg-primary/70 ring-4 ring-primary/10" />
          <div className="flex-1 min-w-0 leading-normal">
            {renderEnhancedChildren(displayChildren)}
            {hasImages && (
              <div className="mt-1 text-xs text-primary/80 italic flex items-center gap-1">
                {expanded ? "Thu gọn ảnh ▲" : "Xem ảnh ▼"}
              </div>
            )}
          </div>
        </div>
        {hasImages && expanded && (
          <div 
            className="mt-2 relative overflow-hidden rounded-md border border-border/50 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300 bg-black/5 cursor-zoom-in"
            onClick={() => setLightboxOpen(true)}
          >
            <img 
              key={images[currentImageIndex]}
              src={images[currentImageIndex]} 
              alt="Preview" 
              className="w-full h-[220px] object-cover animate-in fade-in duration-500" 
            />
            
            {images.length > 1 && (
              <>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex((i) => (i === 0 ? images.length - 1 : i - 1));
                  }}
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
                >
                  ❮
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex((i) => (i === images.length - 1 ? 0 : i + 1));
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
                >
                  ❯
                </button>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
                  {images.map((_, idx) => (
                    <div 
                      key={idx} 
                      className={`w-1.5 h-1.5 rounded-full transition-colors ${idx === currentImageIndex ? 'bg-white' : 'bg-white/40'}`} 
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </li>

      {lightboxOpen && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 animate-in fade-in duration-200"
          onClick={() => setLightboxOpen(false)}
        >
          <button 
            className="absolute top-4 right-4 text-white/70 hover:text-white flex items-center justify-center w-10 h-10 text-2xl z-10"
            onClick={() => setLightboxOpen(false)}
          >
            ✕
          </button>
          
          <div className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center">
            <img 
              key={images[currentImageIndex]}
              src={images[currentImageIndex]} 
              alt="Room large" 
              className="max-w-full max-h-[90vh] object-contain rounded-md shadow-2xl animate-in fade-in zoom-in-95 duration-300"
              onClick={(e) => e.stopPropagation()} 
            />
            
            {images.length > 1 && (
              <>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex((i) => (i === 0 ? images.length - 1 : i - 1));
                  }}
                  className="absolute -left-12 md:-left-16 top-1/2 -translate-y-1/2 text-white/50 hover:text-white text-5xl transition-colors p-4"
                >
                  ❮
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex((i) => (i === images.length - 1 ? 0 : i + 1));
                  }}
                  className="absolute -right-12 md:-right-16 top-1/2 -translate-y-1/2 text-white/50 hover:text-white text-5xl transition-colors p-4"
                >
                  ❯
                </button>
              </>
            )}
            
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-white/70 text-sm font-medium tracking-wide">
              {currentImageIndex + 1} / {images.length}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Extracted static components object so ReactMarkdown NEVER unmounts/remounts components on state change!
const MARKDOWN_COMPONENTS = {
  p: ({ children }: ComponentPropsWithoutRef<"p">) => (
    <p className="mb-2 text-sm leading-relaxed text-foreground/90 last:mb-0">
      {renderEnhancedChildren(children)}
    </p>
  ),
  ul: ({ children }: ComponentPropsWithoutRef<"ul">) => (
    <ul className="my-2.5 space-y-1.5 pl-0 list-none">{children}</ul>
  ),
  ol: ({ children }: ComponentPropsWithoutRef<"ol">) => (
    <ol className="my-2.5 space-y-1.5 pl-4 list-decimal text-sm font-medium leading-relaxed">{children}</ol>
  ),
  li: ({ children }: ComponentPropsWithoutRef<"li">) => (
    <RoomListItem>{children}</RoomListItem>
  ),
  strong: ({ children }: ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-foreground tracking-tight">{children}</strong>
  ),
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary transition-colors"
    >
      {children}
    </a>
  ),
  h1: ({ children }: ComponentPropsWithoutRef<"h1">) => (
    <h1 className="mt-3 mb-1.5 text-base font-bold text-foreground tracking-tight">{children}</h1>
  ),
  h2: ({ children }: ComponentPropsWithoutRef<"h2">) => (
    <h2 className="mt-2.5 mb-1.5 text-sm font-bold text-foreground tracking-tight">{children}</h2>
  ),
  h3: ({ children }: ComponentPropsWithoutRef<"h3">) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold text-foreground">{children}</h3>
  ),
  code: ({ children }: ComponentPropsWithoutRef<"code">) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] font-medium text-foreground">{children}</code>
  ),
  pre: ({ children }: ComponentPropsWithoutRef<"pre">) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{children}</pre>
  ),
};

export const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
