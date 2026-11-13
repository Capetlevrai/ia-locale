import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SpeculativeSchema = z.enum(["auto", "none", "mtp", "dflash"]);
export type Speculative = z.infer<typeof SpeculativeSchema>;

/** auto: CUDA on NVIDIA, Vulkan on AMD and Intel. vulkan: Vulkan everywhere (tests, or a CUDA engine that fails). */
export const BackendSchema = z.enum(["auto", "vulkan"]);
export type Backend = z.infer<typeof BackendSchema>;

export const LocalSettingsSchema = z.object({
  /** Catalog model the engine serves. Null until the user picks one. */
  modelId: z.string().nullable().default(null),
  /** Not shown in the UI. */
  backend: BackendSchema.default("auto"),
  speculative: SpeculativeSchema.default("auto"),
  vision: z.boolean().default(true),
  /**
   * Vision projector on the CPU: ~1 GB more VRAM for the context, but each image is read far
   * more slowly (full-screen capture: 3 s on the card, 51 s on a Ryzen 9800X3D, 8 s once
   * capped at 1024 tokens). Off by default: vision runs on the card.
   */
  visionOnCpu: z.boolean().default(false),
  /**
   * auto: as much context as free VRAM holds (1 GiB margin).
   * budget: as much context as fits in `vramBudgetGb` (leaves room for OBS, games…).
   * manual: fixed `contextTokens`.
   */
  contextMode: z.enum(["auto", "budget", "manual"]).default("auto"),
  contextTokens: z.number().int().min(4096).max(262144).default(65536),
  /** Max VRAM the engine may use in budget mode. 0 = not chosen yet. */
  vramBudgetGb: z.number().min(0).max(256).default(0),
  /** MCP catalog id -> enabled. Missing ids fall back to the catalog default. */
  mcp: z.record(z.string(), z.boolean()).default({}),
  /** Keep Paseo's own MCP tools in local agents. Costs context, off by default. */
  paseoTools: z.boolean().default(false),
  /** Unload the model after this many idle minutes. 0 = never. */
  idleMinutes: z.number().int().min(0).max(1440).default(30),
  /**
   * Cap the model's reasoning per effort level (low 4K, medium 12K, xhigh 32K tokens).
   * Unlimited xhigh reasoning drafted a whole Tetris game twice (~28K tokens, minutes).
   */
  reasoningLimit: z.boolean().default(true),
  /** Sampling temperature override. Null = the model's recommended value. */
  temperature: z.number().min(0).max(2).nullable().default(null),
  /** Local-tuned OMP compaction (late trigger, no-LLM pruning first). Off = OMP defaults. */
  localCompaction: z.boolean().default(true),
  /** Compact once the conversation fills this share of the context (8K always kept free). */
  compactPercent: z.number().int().min(50).max(98).default(95),
});
export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

/**
 * What to save when the user picks a model. In « Budget VRAM » mode, a budget set for a
 * lighter model (15 GB) is too small for a bigger one (the 24 GB model needs 17): the load
 * would only end in an error. Raise the budget to what the picked model needs; the caller
 * tells the user. A budget that is large enough is never touched.
 */
export function settingsForModel(
  values: LocalSettings,
  model: { id: string; comfortBudgetGb: number | null },
): { patch: Partial<LocalSettings>; raisedTo: number | null } {
  const needed = model.comfortBudgetGb;
  const raise = values.contextMode === "budget" && values.vramBudgetGb > 0 && needed !== null && values.vramBudgetGb < needed;
  return { patch: { modelId: model.id, ...(raise ? { vramBudgetGb: needed } : {}) }, raisedTo: raise ? needed : null };
}

/** Sentence shown when settingsForModel raised the budget. */
export function budgetRaisedText(label: string, from: number, to: number): string {
  return `${label} a besoin de plus de place : le budget VRAM passe de ${from} à ${to} Go.`;
}

export const localSettings = defineSettings({
  id: "local",
  scope: "host",
  version: 1,
  schema: LocalSettingsSchema,
});
