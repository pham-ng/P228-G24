import { nowIso } from "./storage";

export type TraceStep = 
  | "request_received"
  | "rag_retrieval"
  | "llm_chat"
  | "tool_call"
  | "form_wizard"
  | "completed"
  | "error";

export interface TraceEvent {
  traceId: string;
  conversationId: number;
  provider: "local" | "openai";
  model: string;
  step: TraceStep;
  details?: Record<string, any>;
  error?: string;
  durationMs?: number;
  timestamp: string;
}

export class AgentTracer {
  private static traces: TraceEvent[] = [];

  static startTrace(conversationId: number, provider: "local" | "openai", model: string): string {
    const traceId = `tr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.log({
      traceId,
      conversationId,
      provider,
      model,
      step: "request_received",
      timestamp: nowIso(),
    });
    return traceId;
  }

  static recordStep(
    traceId: string,
    conversationId: number,
    provider: "local" | "openai",
    model: string,
    step: TraceStep,
    details?: Record<string, any>,
    durationMs?: number
  ) {
    this.log({
      traceId,
      conversationId,
      provider,
      model,
      step,
      details,
      durationMs,
      timestamp: nowIso(),
    });
  }

  static recordError(
    traceId: string,
    conversationId: number,
    provider: "local" | "openai",
    model: string,
    error: any,
    step: TraceStep = "error"
  ) {
    const errorMsg = error?.message || String(error);
    this.log({
      traceId,
      conversationId,
      provider,
      model,
      step,
      error: errorMsg,
      details: { stack: error?.stack },
      timestamp: nowIso(),
    });
  }

  private static log(event: TraceEvent) {
    this.traces.push(event);
    if (this.traces.length > 500) this.traces.shift();

    const prefix = `[TRACER][${event.provider.toUpperCase()}][${event.model}]`;
    if (event.error) {
      console.error(`🚨 ${prefix} [Conv #${event.conversationId}] Step: ${event.step} FAILED! Error: ${event.error}`, event.details ?? "");
    } else {
      const dur = event.durationMs ? ` (${event.durationMs}ms)` : "";
      console.log(`🔍 ${prefix} [Conv #${event.conversationId}] Step: ${event.step}${dur}`, event.details ? JSON.stringify(event.details) : "");
    }
  }

  static getRecentTraces(limit = 20): TraceEvent[] {
    return this.traces.slice(-limit);
  }
}
