/**
 * Timestamped console logging, in a module that imports nothing.
 *
 * This lived in `index.ts`, which is the server's entry point — it builds the
 * Express app, registers every route and starts listening. So `backup.ts`
 * importing one eight-line formatter from it created
 * `routes -> backup -> index -> routes`, a cycle that only stayed invisible
 * because `routes.ts` loaded `backup` through a lazy `require()`.
 *
 * That workaround was itself broken: `require` is not defined in a
 * `"type": "module"` package, so `/metrics`, `/api/metrics` and both backup
 * admin endpoints answered 500 the moment anything called them — the Prometheus
 * scrape target had never once returned a metric.
 *
 * The fix is not a better workaround. A leaf utility does not belong in the
 * entry point, and moving it here means the static imports are legal.
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
