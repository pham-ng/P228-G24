import { providerHealth } from "./llm";
import { listBackups } from "./backup";
import { storage } from "./storage";

let totalChatRequests = 0;
let totalEscalations = 0;
const latencyBuckets: number[] = [];

export function recordChatMetrics(latencyMs: number, escalated: boolean) {
  totalChatRequests++;
  if (escalated) totalEscalations++;
  latencyBuckets.push(latencyMs);
  if (latencyBuckets.length > 1000) latencyBuckets.shift();
}

export function generatePrometheusMetrics(): string {
  const health = providerHealth();
  const ollamaOnline = health.local.available ? 1 : 0;
  const avgLatency = latencyBuckets.length > 0
    ? Math.round(latencyBuckets.reduce((a, b) => a + b, 0) / latencyBuckets.length)
    : 0;

  const backups = listBackups();
  const backupCount = backups.length;
  const lastBackupTs = backups.length > 0 ? Math.floor(new Date(backups[0].createdAt).getTime() / 1000) : 0;
  
  let totalConvs = 0;
  try {
    totalConvs = storage.listConversations().length;
  } catch {
    totalConvs = 0;
  }

  const lines = [
    "# HELP aurea_ollama_status 1 if local Ollama model engine is available, 0 otherwise.",
    "# TYPE aurea_ollama_status gauge",
    `aurea_ollama_status ${ollamaOnline}`,

    "# HELP aurea_gpu_status 1 if GPU inference engine is active and healthy.",
    "# TYPE aurea_gpu_status gauge",
    `aurea_gpu_status ${ollamaOnline}`,

    "# HELP aurea_chat_requests_total Total number of guest chat turns processed.",
    "# TYPE aurea_chat_requests_total counter",
    `aurea_chat_requests_total ${totalChatRequests}`,

    "# HELP aurea_escalations_total Total number of turns escalated to human front desk staff.",
    "# TYPE aurea_escalations_total counter",
    `aurea_escalations_total ${totalEscalations}`,

    "# HELP aurea_response_latency_avg_ms Rolling average response latency in milliseconds.",
    "# TYPE aurea_response_latency_avg_ms gauge",
    `aurea_response_latency_avg_ms ${avgLatency}`,

    "# HELP aurea_local_consecutive_failures Consecutive failures recorded for local LLM provider.",
    "# TYPE aurea_local_consecutive_failures gauge",
    `aurea_local_consecutive_failures ${health.local.consecutiveFailures}`,

    "# HELP aurea_sqlite_backups_total Total number of WAL-safe SQLite backups present.",
    "# TYPE aurea_sqlite_backups_total gauge",
    `aurea_sqlite_backups_total ${backupCount}`,

    "# HELP aurea_last_backup_timestamp_seconds Unix timestamp of the last database backup.",
    "# TYPE aurea_last_backup_timestamp_seconds gauge",
    `aurea_last_backup_timestamp_seconds ${lastBackupTs}`,

    "# HELP aurea_conversations_total Total active guest conversations stored in database.",
    "# TYPE aurea_conversations_total gauge",
    `aurea_conversations_total ${totalConvs}`,
  ];

  return lines.join("\n") + "\n";
}
