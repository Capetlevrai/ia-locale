import type { AgentStats, TurnStats } from "../shared/rpc";

/** llama-server `timings` block, sent on every streamed chunk with timings_per_token. */
export interface LlamaTimings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

interface Turn {
  agentId: string;
  workspaceId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: TurnStats["outcome"];
  calls: number;
  /** Totals of finished model calls. */
  done: Required<Pick<LlamaTimings, "cache_n" | "prompt_n" | "prompt_ms" | "predicted_n" | "predicted_ms" | "draft_n" | "draft_n_accepted">>;
  /** Latest timings of the call in flight. */
  live: LlamaTimings | null;
  firstTokenAt: number | null;
}

const turns = new Map<string, { current: Turn | null; last: Turn | null; workspaceId: string | null }>();
/** Agents with a turn in progress, most recent last. Model calls are credited to the last one. */
const active: string[] = [];

const zero = () => ({ cache_n: 0, prompt_n: 0, prompt_ms: 0, predicted_n: 0, predicted_ms: 0, draft_n: 0, draft_n_accepted: 0 });

export function turnStarted(agentId: string, workspaceId: string | null): void {
  const entry = turns.get(agentId) ?? { current: null, last: null, workspaceId };
  entry.workspaceId = workspaceId;
  entry.current = {
    agentId,
    workspaceId,
    startedAt: Date.now(),
    endedAt: null,
    outcome: "running",
    calls: 0,
    done: zero(),
    live: null,
    firstTokenAt: null,
  };
  turns.set(agentId, entry);
  const i = active.indexOf(agentId);
  if (i >= 0) active.splice(i, 1);
  active.push(agentId);
}

export function turnEnded(agentId: string, outcome: Exclude<TurnStats["outcome"], "running">): void {
  const entry = turns.get(agentId);
  const turn = entry?.current;
  if (!entry || !turn) return;
  flushLive(turn);
  turn.endedAt = Date.now();
  turn.outcome = outcome;
  entry.last = turn;
  entry.current = null;
  const i = active.indexOf(agentId);
  if (i >= 0) active.splice(i, 1);
}

function currentTurn(): Turn | null {
  const agentId = active.at(-1);
  return agentId ? (turns.get(agentId)?.current ?? null) : null;
}

function flushLive(turn: Turn): void {
  const t = turn.live;
  if (!t) return;
  for (const key of Object.keys(turn.done) as (keyof Turn["done"])[]) turn.done[key] += t[key] ?? 0;
  turn.live = null;
}

/** A model call started at the gateway. */
export function callStarted(): void {
  const turn = currentTurn();
  if (!turn) return;
  flushLive(turn);
  turn.calls += 1;
}

/** Timings from a chunk (running totals for the call) or from a final response. */
export function callTimings(timings: LlamaTimings): void {
  const turn = currentTurn();
  if (!turn) return;
  if (turn.firstTokenAt === null && (timings.predicted_n ?? 0) > 0) turn.firstTokenAt = Date.now();
  turn.live = timings;
}

function snapshot(turn: Turn): TurnStats {
  const live = turn.live ?? {};
  const sum = (key: keyof Turn["done"]) => turn.done[key] + (live[key] ?? 0);
  const genTokens = sum("predicted_n");
  const genMs = sum("predicted_ms");
  const promptTokens = sum("prompt_n");
  const promptMs = sum("prompt_ms");
  const draftN = sum("draft_n");
  const end = turn.endedAt ?? Date.now();
  return {
    agentId: turn.agentId,
    workspaceId: turn.workspaceId,
    outcome: turn.outcome,
    startedAt: turn.startedAt,
    elapsedMs: end - turn.startedAt,
    firstTokenMs: turn.firstTokenAt === null ? null : turn.firstTokenAt - turn.startedAt,
    calls: turn.calls,
    promptTokens,
    cachedTokens: sum("cache_n"),
    promptTokS: promptMs > 0 ? (promptTokens / promptMs) * 1000 : null,
    genTokens,
    genTokS: genMs > 0 ? (genTokens / genMs) * 1000 : null,
    // While generating, show the in-flight call's own speed: it reacts instantly.
    liveTokS: turn.outcome === "running" && turn.live?.predicted_per_second ? turn.live.predicted_per_second : null,
    draftAcceptance: draftN > 0 ? sum("draft_n_accepted") / draftN : null,
  };
}

export function agentStats(): AgentStats[] {
  return [...turns.entries()].map(([agentId, entry]) => ({
    agentId,
    workspaceId: entry.workspaceId,
    current: entry.current ? snapshot(entry.current) : null,
    last: entry.last ? snapshot(entry.last) : null,
  }));
}
