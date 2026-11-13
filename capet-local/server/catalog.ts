// Built-in catalog. Later versions fetch an updated copy from the website and
// fall back to this one when offline.

import type { GpuInfo } from "../shared/rpc";
import type { Backend } from "../shared/settings";

/** Windows: CUDA 12.4 / 13.4. Linux: CUDA 12.8 / 13.4. Vulkan on both. Metal on Apple Silicon Macs. */
export type RuntimeVariant = "cuda-12.4" | "cuda-12.8" | "cuda-13.4" | "vulkan" | "metal";

export interface HfFile {
  repo: string;
  file: string;
  revision: string;
  size: number;
  /** SHA-256 of the file (Hugging Face LFS oid): checked after download. */
  sha256: string;
  /** Unique name under the models folder: HF file names collide across repos. */
  localName: string;
}

export interface CatalogModel {
  id: string;
  label: string;
  /** Maker, base model and quantization, shown under the friendly label. */
  technical: string;
  description: string;
  main: HfFile;
  mmproj?: HfFile;
  /** DFlash draft model. DFlash and vision cannot run together. */
  dflash?: HfFile & { draftMax: number };
  mtp: boolean;
  /** VRAM (GB) for the full model + vision + a comfortable context. */
  recommendedVramGb: number;
  /** Below this the model does not fit on the GPU at all. */
  minVramGb: number;
  /**
   * KV cache cost per context token at q8_0 (KiB), MTP draft context included.
   * Drives the budget -> context estimate. Qwen3.8 27B: 44.6 measured; others estimated.
   */
  kvKiBPerToken: number;
  /** KV cache type (default q8_0). q4_0 halves the cache where VRAM is tightest. */
  kvCacheType?: "q8_0" | "q4_0";
  /**
   * Mixture of experts. When the card can't hold the whole model with MOE_CTX of
   * context, expert weights go to the CPU instead of the context shrinking: only
   * ~3B parameters run per token, so it stays fast (12 GB card: 133 tok/s, 64K).
   */
  moe?: boolean;
  sampling: { temp: number; topP: number; topK: number; minP: number };
  /** OMP model "compat" block for this family. */
  ompCompat: Record<string, unknown>;
  reasoningEfforts: string[] | null;
}

export interface CatalogMcp {
  id: string;
  label: string;
  description: string;
  /** Approximate prompt cost in an OMP session (OMP mounts MCP tools lazily). */
  tokens: number;
  enabledByDefault: boolean;
  /** Executable that must be on PATH. */
  requires: "npx" | null;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export const RUNTIME = {
  /** llama.cpp v0.7.0. Previous: b10964 (v0.4.1). */
  tag: "b11669",
  repo: "ggml-org/llama.cpp",
  /**
   * CUDA on NVIDIA (Blackwell, compute 12.x, needs the CUDA 13 build), Vulkan on AMD and
   * Intel or when forced, Metal on a Mac. Vulkan on an RTX 4090 (2026-10-18): MTP, vision,
   * tools and --fit all work; ~15 % slower writing, reading 2-3x slower, first prompt +15 s
   * (shader compile).
   */
  variantFor(gpu: Pick<GpuInfo, "vendor" | "computeCap">, backend: Backend = "auto", platform: NodeJS.Platform = process.platform): RuntimeVariant {
    if (platform === "darwin") return "metal";
    if (backend === "vulkan" || gpu.vendor !== "nvidia") return "vulkan";
    if (gpu.computeCap >= 12) return "cuda-13.4";
    return platform === "win32" ? "cuda-12.4" : "cuda-12.8";
  },
  /** Release archives: the engine, plus NVIDIA's CUDA libraries for the CUDA builds. */
  assets(variant: RuntimeVariant, platform: NodeJS.Platform = process.platform): string[] {
    const { tag } = RUNTIME;
    if (variant === "metal") return [`llama-${tag}-bin-macos-arm64.tar.gz`];
    if (platform === "win32") {
      const engine = `llama-${tag}-bin-win-${variant}-x64.zip`;
      return variant === "vulkan" ? [engine] : [engine, `cudart-llama-bin-win-${variant}-x64.zip`];
    }
    const engine = `llama-${tag}-bin-ubuntu-${variant}-x64.tar.gz`;
    return variant === "vulkan" ? [engine] : [engine, `cudart-llama-${tag}-bin-ubuntu-${variant}-x64.tar.gz`];
  },
  /** Approximate download, shown before it starts (MB). */
  downloadMb(variant: RuntimeVariant): number {
    return variant === "vulkan" || variant === "metal" ? 30 : 650;
  },
};

const QWEN_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "qwen-chat-template",
  qwenTemplateReasoningEffort: true,
  reasoningContentField: "reasoning_content",
  requiresReasoningContentForToolCalls: true,
};

const QWEN_SAMPLING = { temp: 1.0, topP: 0.95, topK: 20, minP: 0.0 };
/** Qwen3.6 35B-A3B: Tetris bench 2026-10-17, temp 0.6 averaged 2.25/10 vs 0.25 at 1.0. */
const QWEN36_SAMPLING = { temp: 0.6, topP: 0.95, topK: 20, minP: 0.0 };

/** ByteShape's repo, pinned: a re-upload on `main` would no longer match the sizes and hashes below. */
const BYTESHAPE_REVISION = "83dc80a65cb948b8e5a9dd9776eda7425180dacc";

const SWIFT_MMPROJ: HfFile = {
  repo: "ukisai/Swift-1.5-Qwen3.8-27B-GGUF",
  file: "mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf",
  revision: "14bfe4b42be4a925d98816db830155f476c605e7",
  size: 927606912,
  sha256: "10a24dc46eb801ad794886ef27ea1e43634d35388dfaf2e2374b7a8b67faf526",
  localName: "mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf",
};

export const MODELS: CatalogModel[] = [
  {
    id: "swift15-27b-iq4",
    label: "Swift 1.5 — 24 Go",
    technical: "UkisAI Swift 1.5 (affinage de Qwen3.8 27B) · IQ4_XS",
    description: "",
    main: {
      repo: "ukisai/Swift-1.5-Qwen3.8-27B-GGUF",
      file: "Swift-1.5-Qwen3.8-27B-IQ4_XS.gguf",
      revision: "14bfe4b42be4a925d98816db830155f476c605e7",
      size: 15475951296,
      sha256: "e3b59faa312a6202d7ac0a2400123956104bc720e77f6ff21c754aec5c3740df",
      localName: "Swift-1.5-Qwen3.8-27B-IQ4_XS.gguf",
    },
    mmproj: SWIFT_MMPROJ,
    mtp: true,
    recommendedVramGb: 23,
    minVramGb: 19,
    kvKiBPerToken: 45,
    sampling: QWEN_SAMPLING,
    ompCompat: QWEN_COMPAT,
    reasoningEfforts: ["low", "medium", "xhigh"],
  },
  {
    id: "swift15-27b-iq3",
    label: "Swift 1.5 — 16 Go",
    technical: "UkisAI Swift 1.5 (affinage de Qwen3.8 27B) · GSQ-RCO IQ3_XXS",
    description: "",
    main: {
      repo: "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF",
      file: "Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf",
      revision: "d74895bbe5db4bec1e0024e7cc87d59c02d7631a",
      size: 10442827776,
      sha256: "e23eb251493b8a89f7d0217590b593e696ac9bacaeac8605541e477533dc5838",
      localName: "Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf",
    },
    mmproj: SWIFT_MMPROJ,
    mtp: true,
    recommendedVramGb: 16,
    minVramGb: 13,
    kvKiBPerToken: 45,
    sampling: QWEN_SAMPLING,
    ompCompat: QWEN_COMPAT,
    reasoningEfforts: ["low", "medium", "xhigh"],
  },
  {
    id: "qwen36-35b-a3b-24",
    label: "Qwen3.6 35B-A3B — 24 Go (rapide)",
    technical: "ByteShape · Qwen3.6 35B-A3B (MoE) · IQ4_XS 4,19 bpw",
    description: "",
    main: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "Qwen3.6-35B-A3B-IQ4_XS-4.19bpw.gguf",
      revision: BYTESHAPE_REVISION,
      size: 18605304512,
      sha256: "51eddce8a0cb63744edc677bff5f33834fb7cbab974124a6b4e43c54658a7b43",
      localName: "Qwen3.6-35B-A3B-IQ4_XS-4.19bpw.gguf",
    },
    mmproj: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "mmproj-bf16.gguf",
      revision: BYTESHAPE_REVISION,
      size: 902822240,
      sha256: "1c625f05cd52e90abc76a5f756226c3a5fe279593379c22f6c6846c970a0cd18",
      localName: "Qwen3.6-35B-A3B-ByteShape-mmproj-bf16.gguf",
    },
    mtp: true,
    moe: true,
    recommendedVramGb: 22,
    minVramGb: 20,
    kvKiBPerToken: 20,
    sampling: QWEN36_SAMPLING,
    ompCompat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    reasoningEfforts: null,
  },
  {
    id: "qwen36-35b-a3b-iq4",
    label: "Qwen3.6 35B-A3B — 12 et 16 Go (rapide)",
    technical: "ByteShape · Qwen3.6 35B-A3B (MoE) · IQ4_XS 3,53 bpw",
    description: "",
    main: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "Qwen3.6-35B-A3B-IQ4_XS-3.53bpw.gguf",
      revision: BYTESHAPE_REVISION,
      size: 15669422784,
      sha256: "3e4c1ccd0f4c7246614f28050a07b5d005bcf95d19813485f6c10666d8d70696",
      localName: "Qwen3.6-35B-A3B-IQ4_XS-3.53bpw.gguf",
    },
    mmproj: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "mmproj-bf16.gguf",
      revision: BYTESHAPE_REVISION,
      size: 902822240,
      sha256: "1c625f05cd52e90abc76a5f756226c3a5fe279593379c22f6c6846c970a0cd18",
      localName: "Qwen3.6-35B-A3B-ByteShape-mmproj-bf16.gguf",
    },
    mtp: true,
    moe: true,
    recommendedVramGb: 12,
    minVramGb: 11,
    kvKiBPerToken: 20,
    sampling: QWEN36_SAMPLING,
    ompCompat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    reasoningEfforts: null,
  },
  {
    id: "qwen36-35b-a3b-10go",
    label: "Qwen3.6 35B-A3B — 10 Go (rapide)",
    technical: "ByteShape · Qwen3.6 35B-A3B (MoE) · IQ4_XS 3,53 bpw",
    description: "",
    main: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "Qwen3.6-35B-A3B-IQ4_XS-3.53bpw.gguf",
      revision: BYTESHAPE_REVISION,
      size: 15669422784,
      sha256: "3e4c1ccd0f4c7246614f28050a07b5d005bcf95d19813485f6c10666d8d70696",
      localName: "Qwen3.6-35B-A3B-IQ4_XS-3.53bpw.gguf",
    },
    mmproj: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "mmproj-bf16.gguf",
      revision: BYTESHAPE_REVISION,
      size: 902822240,
      sha256: "1c625f05cd52e90abc76a5f756226c3a5fe279593379c22f6c6846c970a0cd18",
      localName: "Qwen3.6-35B-A3B-ByteShape-mmproj-bf16.gguf",
    },
    mtp: true,
    moe: true,
    recommendedVramGb: 10,
    minVramGb: 8,
    kvKiBPerToken: 20,
    sampling: QWEN36_SAMPLING,
    ompCompat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    reasoningEfforts: null,
  },
  // --- Uncensored (abliterated) models. Last in the list: never the recommended one. ---
  {
    id: "swift15-27b-uncensored-16",
    label: "Swift 1.5 non censuré — 16 Go",
    technical: "ajgazin · Swift 1.5 abliterated (Qwen3.8 27B) · RCO IQ3_XXS",
    description: "Répond aussi aux demandes que les autres modèles refusent.",
    // Same size and tensor layout as the 16 GB Swift above, so the same context. UD-IQ3_XXS
    // reads a bit closer to the original but is 0.5 GB bigger: ~16K context instead of ~30K
    // on a 16 GB card that drives the screen, with vision.
    main: {
      repo: "ajgazin/Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-GGUF",
      file: "RCO/Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-RCO-IQ3_XXS.gguf",
      revision: "540448475b2a84843fa2a54fcfd9c888de8a99ca",
      size: 10442827392,
      sha256: "e13d3e7400b6c7f980ebd30c0edd6be43eb1865b50be8562a9db042706c7d803",
      localName: "Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-RCO-IQ3_XXS.gguf",
    },
    // Abliteration edits the language model only: Swift's own projector reads images for it.
    mmproj: SWIFT_MMPROJ,
    mtp: true,
    recommendedVramGb: 16,
    minVramGb: 13,
    kvKiBPerToken: 45,
    sampling: QWEN_SAMPLING,
    ompCompat: QWEN_COMPAT,
    reasoningEfforts: ["low", "medium", "xhigh"],
  },
  {
    id: "qwen36-35b-a3b-uncensored",
    label: "Qwen3.6 35B-A3B non censuré — 12 et 16 Go",
    technical: "Bahushruth · Qwen3.6 35B-A3B abliterated v4 (MoE) · IQ3_M",
    description: "Répond aussi aux demandes que les autres modèles refusent.",
    main: {
      repo: "Bahushruth/Qwen3.6-35B-A3B-abliterated-v4-GGUF",
      file: "Qwen3.6-35B-A3B-abliterated-v4-IQ3_M.gguf",
      revision: "b8a9ab20c8bde880621a7bab65073c0078ef33f7",
      size: 15440519328,
      sha256: "70ab5f42ff0952deda29fc80f337bf4b3ffb3e0b906c0a1f718d84c9817595da",
      localName: "Qwen3.6-35B-A3B-abliterated-v4-IQ3_M.gguf",
    },
    // The repo ships no projector; the base model's (ByteShape) reads images for it.
    mmproj: {
      repo: "byteshape/Qwen3.6-35B-A3B-MTP-GGUF",
      file: "mmproj-bf16.gguf",
      revision: BYTESHAPE_REVISION,
      size: 902822240,
      sha256: "1c625f05cd52e90abc76a5f756226c3a5fe279593379c22f6c6846c970a0cd18",
      localName: "Qwen3.6-35B-A3B-ByteShape-mmproj-bf16.gguf",
    },
    // Only the 69 GB BF16 file of this repo keeps the MTP head.
    mtp: false,
    moe: true,
    recommendedVramGb: 12,
    minVramGb: 11,
    kvKiBPerToken: 20,
    sampling: QWEN36_SAMPLING,
    ompCompat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    reasoningEfforts: null,
  },
];

// Exact versions: `@latest` would run whatever was published last, untested, on every agent start.
export const MCPS: CatalogMcp[] = [
  {
    id: "playwright",
    label: "Navigateur (Playwright)",
    description: "Permet à l'agent d'ouvrir et tester des pages web.",
    tokens: 900,
    enabledByDefault: false,
    requires: "npx",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.85"],
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    description: "Inspecte une page dans Chrome : console, réseau, performances.",
    tokens: 900,
    enabledByDefault: false,
    requires: "npx",
    command: "npx",
    // --isolated: own temporary profile. Without it the MCP refuses to start as soon
    // as another chrome-devtools session holds the shared profile (seen in agent tests).
    args: ["-y", "chrome-devtools-mcp@1.13.0", "--isolated"],
  },
  {
    id: "context7",
    label: "Documentation (Context7)",
    description: "Donne à l'agent la doc à jour des librairies.",
    tokens: 500,
    enabledByDefault: false,
    requires: "npx",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@4.7.0"],
  },
];

/** Measured 2026-10-17: OMP 18.8 system prompt + built-in tools, first request on Qwen3.8. */
export const OMP_BASE_TOKENS = 8300;
/** Paseo's own MCP (agent orchestration tools). */
export const PASEO_TOOLS_TOKENS = 3000;

export function findModel(id: string | null): CatalogModel | undefined {
  return MODELS.find((m) => m.id === id);
}
