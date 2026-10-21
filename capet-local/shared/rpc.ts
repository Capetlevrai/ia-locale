import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Speculative } from "./settings";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

export interface GpuInfo {
  /** NVIDIA runs the CUDA engine, a Mac the Metal one, every other vendor the Vulkan one. */
  vendor: GpuVendor;
  /** nvidia-smi index (PCI bus order), -1 for other vendors: the engine runs on this card only. */
  index: number;
  /** Graphics cards in the PC. */
  cards: number;
  name: string;
  /** On a Mac: the share of RAM macOS lets the GPU use. */
  vramTotalMiB: number;
  /** Used by every program (the driver also reserves a few hundred MiB, so used + free < total). */
  vramUsedMiB: number;
  vramFreeMiB: number;
  /** CUDA compute capability, 0 for other vendors. */
  computeCap: number;
}

export interface Progress {
  label: string;
  done: number;
  total: number;
  state: "running" | "done" | "error";
  error?: string;
}

/** recommended: the single best model for this card; compatible: fits comfortably;
 *  tight: fits with a reduced context; too_big: does not fit. */
export type ModelTier = "recommended" | "compatible" | "tight" | "too_big";

export interface ModelStatus {
  id: string;
  label: string;
  /** e.g. "ByteShape · Qwen3.8 27B · IQ4_XS 3,84 bpw" */
  technical: string;
  /** Hugging Face repo of the main weights. */
  repo: string;
  description: string;
  sizeBytes: number;
  tier: ModelTier;
  installed: boolean;
  download: Progress | null;
  features: { mtp: boolean; dflash: boolean; vision: boolean };
  /** Smallest VRAM budget (MiB) that holds this model with the current vision/DFlash choice and a 16K context. */
  minBudgetMiB: number;
  dflashInstalled: boolean;
  dflashDownload: Progress | null;
}

export interface McpStatus {
  id: string;
  label: string;
  description: string;
  tokens: number;
  enabledByDefault: boolean;
  requires: string | null;
  available: boolean;
}

export type EngineState = "stopped" | "starting" | "ready" | "error";

export interface EngineStatus {
  state: EngineState;
  modelId: string | null;
  ctx: number | null;
  speculative: Exclude<Speculative, "auto"> | null;
  vision: boolean;
  /** Budget the engine was started with, null outside budget mode. */
  vramBudgetMiB: number | null;
  /** Measured: free VRAM before loading minus free VRAM after. */
  vramUsedMiB: number | null;
  /** Something the plugin adjusted on its own (shown as information, no action needed). */
  notice: string | null;
  error: string | null;
  logTail: string[];
  /** Settings revision the running engine and agent configs were built from. */
  appliedRevision: string | null;
}

export interface Status {
  gpu: GpuInfo | null;
  /** sizeMb: download size of the engine build for this card. */
  runtime: { installed: boolean; label: string; sizeMb: number; download: Progress | null };
  omp: { installed: boolean; version: string | null };
  node: boolean;
  models: ModelStatus[];
  mcp: McpStatus[];
  engine: EngineStatus;
  /** Budget choices (whole GB) for the selected model, with the context each would give. */
  budgetOptions: { gb: number; estCtx: number }[];
  gatewayUrl: string;
  /** Tokens an OMP session costs before the first message, without MCPs. */
  agentBaseTokens: number;
  dataDir: string;
}

/** One agent turn: from the prompt being sent to the final answer. */
export interface TurnStats {
  agentId: string;
  workspaceId: string | null;
  outcome: "running" | "completed" | "failed" | "canceled";
  /** Epoch ms, to pick the most recent turn. */
  startedAt: number;
  /** Prompt sent -> final answer (or now, while running). */
  elapsedMs: number;
  /** Prompt sent -> first generated token. */
  firstTokenMs: number | null;
  /** Model calls in the turn (one per tool round-trip). */
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  promptTokS: number | null;
  /** Generated tokens, reasoning included. */
  genTokens: number;
  genTokS: number | null;
  /** Speed of the call in flight, while running. */
  liveTokS: number | null;
  /** Share of speculative (MTP/DFlash) draft tokens the model accepted. */
  draftAcceptance: number | null;
}

export interface AgentStats {
  agentId: string;
  workspaceId: string | null;
  current: TurnStats | null;
  last: TurnStats | null;
}

export const statsRpc = defineRpc({
  name: "local.stats",
  input: z.object({}),
  output: z.custom<{ agents: AgentStats[] }>(),
});

export const statusRpc = defineRpc({
  name: "local.status",
  input: z.object({}),
  output: z.custom<Status>(),
});

export const downloadModelRpc = defineRpc({
  name: "local.download-model",
  input: z.object({ modelId: z.string(), part: z.enum(["model", "dflash"]).default("model") }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

export const cancelDownloadRpc = defineRpc({
  name: "local.cancel-download",
  input: z.object({ modelId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const installRuntimeRpc = defineRpc({
  name: "local.install-runtime",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

export const applyRpc = defineRpc({
  name: "local.apply",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const stopRpc = defineRpc({
  name: "local.stop",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
