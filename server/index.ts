import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { recordHttpStatus } from "./metrics-extra";
import { createServer } from "node:http";
import { ZodError } from "zod";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

/* Moved to ./log so a leaf utility does not drag the entry point into an
   import cycle. Re-exported because other modules and scripts import it from
   here. */
export { log } from "./log";
import { log } from "./log";

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    /* Đếm mọi phản hồi API theo lớp mã trạng thái. Đặt ở đây chứ không rắc vào
       từng handler: một handler mới quên đếm là một lỗ trong biểu đồ mà không
       ai phát hiện cho tới lúc có sự cố. */
    if (path.startsWith("/api")) recordHttpStatus(res.statusCode);
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  /**
   * Đường `/api` không khớp phải kêu 404, không được trả trang web.
   *
   * Cả `setupVite` lẫn `serveStatic` đều bắt mọi đường còn lại và trả
   * `index.html` với mã 200 — kể cả `/api/...`. Nên một đường API gõ sai
   * hoặc đã bị gỡ trả về 200 kèm HTML, `res.json()` nổ ở phía client với một
   * lỗi cú pháp không liên quan gì tới nguyên nhân, và người đọc log thấy
   * toàn 200.
   *
   * Phát hiện khi probe kiểm `/api/bench/report` đã gỡ: nó vẫn trả 200 sau
   * khi route bị xoá và khởi động lại server. Route đã biến mất thật; thứ trả
   * lời là catch-all.
   *
   * Đặt sau mọi route và trước Vite, nên không đường API thật nào chạm tới.
   */
  app.use("/api", (req, res) => {
    res.status(404).json({ message: `Không có tuyến ${req.method} /api${req.path}` });
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    /**
     * A malformed request is the caller's mistake, not a server fault.
     *
     * Every handler in routes.ts validates with `z.object(...).parse()`, which
     * throws, and nothing caught `ZodError` — so the handler below stamped 500
     * on all of it. Three costs, and the third is the one that matters:
     * the client cannot tell "you sent the wrong thing" from "the server is
     * broken" and so cannot show a useful message; a 500 is logged as
     * "Internal Server Error" with a stack, burying real faults in noise; and
     * on a monitored deployment a guest fat-fingering a form pages somebody.
     *
     * Found by sending an empty basket to /api/guest/order and getting a 500.
     * `zod-validation-error` has been a dependency the whole time and was
     * imported nowhere; the issue list is formatted here instead, so there is
     * one place to change rather than one per handler.
     */
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return res.status(400).json({ message: detail || "Invalid request." });
    }

    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(port, "127.0.0.1", async () => {
    log(`serving on port ${port}`);
    /* Verify the vector index against the running configuration before the first
       guest asks anything. This deployment once ran with a 1536-d index and a
       384-d embedder: the vector leg switched itself off, retrieval became
       keyword-only, and Korean, Chinese and Japanese questions returned nothing
       at all — with no error anywhere. The check runs after listen() so a broken
       index degrades the answer quality rather than the availability of the
       kiosk, but it is never silent again. */
    const { reportIndexHealth } = await import("./index-health");
    await reportIndexHealth();

    /* Embed the intent prototypes once, off the request path. Optional layer:
       a failure here must never keep the kiosk from booting. */
    const { warmIntentNet } = await import("./intent-net");
    void warmIntentNet();
    const { warmSentimentNet } = await import("./sentiment-net");
    void warmSentimentNet();

    const { startBackupScheduler } = await import("./backup");
    startBackupScheduler(24);
  });
})();
