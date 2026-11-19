// Built-in catalog. Later versions fetch an updated copy from the website and
// fall back to this one when offline.

import type { GpuInfo } from "../shared/rpc";
import type { Backend } from "../shared/settings";
import { existsSync } from "node:fs";
import { paths } from "./paths";

/** GPU families we run AMD's ROCm engine on (one archive each): discrete RDNA 2, 3 and 4. */
export type RocmFamily = "gfx103X" | "gfx110X" | "gfx120X";

/**
 * Windows: CUDA 12.4 / 13.5 on NVIDIA, ROCm on the AMD cards it covers. Linux: CUDA 12.8 / 13.5.
 * Vulkan on both for the rest. Metal on Apple Silicon Macs.
 */
export type RuntimeVariant = "cuda-12.4" | "cuda-12.8" | "cuda-13.5" | "vulkan" | "metal" | `rocm-${RocmFamily}`;

export function isRocm(variant: RuntimeVariant): boolean {
  return variant.startsWith("rocm-");
}

/**
 * AMD's own engine (ROCm/HIP) for Windows, from lemonade-sdk/llamacpp-rocm (MIT): one zip
 * per GPU family that carries the whole ROCm runtime, so the Adrenalin driver is all it
 * needs. The official llama.cpp ROCm zip lacks hipblas.dll and silently runs on the CPU.
 *
 * Where it serves, from published measures (none of ours: we have no Radeon):
 * - RX 9000 (gfx120X), by default. A 27B model with its context fills a 16 GB card, and past
 *   ~9 GB on the card the Vulkan driver leaves buffers in shared memory (a tester's RX 9070
 *   XT: 8 tok/s, 18.8 with 60 layers of 65). Stock ROCm: 36-40 tok/s on that card, Vulkan
 *   21-22 when it fits (github.com/lnieuwenhuis/rdna4-27b-inference).
 * - RX 7000 and 6000 (gfx110X, gfx103X), on request only. When the model fits in VRAM Vulkan
 *   writes as fast or faster (RX 7900 XTX: 191 tok/s against 164); ROCm reads prompts faster.
 * - Integrated chips (780M, 890M, 8060S...): never. Vulkan is faster there, and ROCm has
 *   given wrong answers at full speed on them (llamacpp-rocm #123).
 * Every launch checks that ROCm sees the card and loads onto it; Vulkan takes over otherwise.
 *
 * b1380 = llama.cpp build 12515 with a ROCm 10.3 nightly, which carries the fix for pinned
 * host memory with an integrated chip next to the card (TheRock #9339). Its publisher runs
 * inference on gfx1151 hardware only: these three archives are checked statically. Open on
 * RX 9070 XT: prompts read 2.5x slower since b1357 with IQ3_XXS and a q8_0 cache (#155).
 */
export const ROCM = {
  tag: "b1380",
  repo: "lemonade-sdk/llamacpp-rocm",
  /** Windows archives of that release: size (MB) and SHA-256, from its checksums.txt. */
  families: {
    gfx103X: { sizeMb: 550, sha256: "c52da701f8af8c0c4f5847d9f8d5470a096195a7f410d774eec244c3fbdfe5e2" },
    gfx110X: { sizeMb: 540, sha256: "4667ac23ebef5108518b93845b45dbd21eb175e829d0c577db046b5ecdb74443" },
    gfx120X: { sizeMb: 700, sha256: "72909a8824c26656a23263a24d5408076fec5aed08ada75aa1317b0393e1afec" },
  } satisfies Record<RocmFamily, { sizeMb: number; sha256: string }>,
  /** Families where ROCm is the automatic choice. The others get it on request. */
  byDefault: ["gfx120X"] as RocmFamily[],
  /**
   * PCI device id of the chip -> family: what decides. An AMD chip that is not listed is
   * not covered (RDNA 1, every integrated chip, a chip newer than this list) and Vulkan
   * serves. From the Linux kernel (amdgpu_drv.c, kfd_device.c), pci.ids and libdrm's amdgpu.ids.
   */
  devices: {
    // RDNA 2 discrete, Navi 21 to 24: RX 6950 XT to 6400, their M and S, Radeon PRO W6000.
    gfx103X: [
      0x73a0, 0x73a1, 0x73a2, 0x73a3, 0x73a5, 0x73a8, 0x73a9, 0x73ab, 0x73ac, 0x73ad, 0x73ae, 0x73af, 0x73bf,
      0x73c0, 0x73c1, 0x73c3, 0x73da, 0x73db, 0x73dc, 0x73dd, 0x73de, 0x73df,
      0x73e0, 0x73e1, 0x73e2, 0x73e3, 0x73e8, 0x73e9, 0x73ea, 0x73eb, 0x73ec, 0x73ed, 0x73ef, 0x73ff,
      0x7420, 0x7421, 0x7422, 0x7423, 0x7424, 0x743f,
    ],
    // RDNA 3 discrete, Navi 31 to 33: RX 7900 to 7600, their M and S, Radeon PRO W7000.
    gfx110X: [
      0x744c, 0x7448, 0x7449, 0x744a, 0x744b, 0x745e, 0x747e, 0x7470, 0x7460, 0x7461,
      0x7480, 0x7483, 0x7489, 0x7499, 0x749f, 0x73f0, 0x7487, 0x748b,
    ],
    // RDNA 4, Navi 48 and 44: RX 9070 XT / 9070 / 9060 XT / 9060 / 9050, Radeon AI PRO R9700 / R9600.
    gfx120X: [0x7550, 0x7551, 0x7590],
  } satisfies Record<RocmFamily, number[]>,
  /**
   * Card name -> family, only when the device id is unknown. Exact models, never ranges:
   * an unknown model stays on Vulkan.
   */
  rules: [
    [/\bradeon rx ?90(50|60|70)(?![0-9])/, "gfx120X"],
    [/\bradeon ai pro r9(600|700)(?![0-9])/, "gfx120X"],
    [/\bradeon rx ?7(300|400|500|600|650|700|800|900)(?![0-9])/, "gfx110X"],
    [/\bradeon pro w7(400|500|600|700|800|900)(?![0-9])/, "gfx110X"],
    [/\bradeon pro v710(?![0-9])/, "gfx110X"],
    [/\bradeon rx ?6(300|400|450|500|550|600|650|700|750|800|850|900|950)(?![0-9])/, "gfx103X"],
    [/\bradeon 6550s(?![0-9a-z])/, "gfx103X"],
    [/\bradeon pro w6(300|400|500|600|800|900)(?![0-9])/, "gfx103X"],
    [/\bradeon pro v620(?![0-9])/, "gfx103X"],
  ] as [RegExp, RocmFamily][],
  /** The family whose archive runs this card, or null. */
  familyFor(gpu: Pick<GpuInfo, "vendor" | "name" | "deviceId">, platform: NodeJS.Platform = process.platform): RocmFamily | null {
    if (platform !== "win32") return null;
    if (existsSync(paths.rocmTest)) return "gfx120X";
    if (gpu.vendor !== "amd") return null;
    if (gpu.deviceId) {
      const known = Object.entries(ROCM.devices).find(([, ids]) => ids.includes(gpu.deviceId));
      return known ? (known[0] as RocmFamily) : null;
    }
    const name = gpu.name.toLowerCase().replace(/\(tm\)|\(r\)|™|®/g, " ").replace(/\s+/g, " ").trim();
    const families = new Set(ROCM.rules.filter(([pattern]) => pattern.test(name)).map(([, family]) => family));
    return families.size === 1 ? [...families][0] : null;
  },
  family(variant: RuntimeVariant): RocmFamily {
    return variant.slice("rocm-".length) as RocmFamily;
  },
  asset(variant: RuntimeVariant): string {
    return `llama-${ROCM.tag}-windows-rocm-${ROCM.family(variant)}-x64.zip`;
  },
};

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
  /**
   * llama.cpp of 2026-11-18 (after v1.0.0). Previous: b11669 (2026-10-15). Taken for its Vulkan
   * work on AMD (RDNA3/RDNA4 kernels, host-memory fixes, a Windows driver workaround). On an
   * RTX 4090 both builds measure the same. Vulkan with MTP: ~79 tok/s on code (56 without), ~50
   * on short prose (56 without). CUDA with MTP: ~83 on prose, ~98 in an agent run.
   */
  tag: "b12503",
  repo: "ggml-org/llama.cpp",
  /**
   * CUDA on NVIDIA (Blackwell, compute 12.x, needs the CUDA 13 build), Vulkan on AMD and
   * Intel or when forced, Metal on a Mac. Vulkan on an RTX 4090 (2026-10-18): MTP, vision,
   * tools and --fit all work; ~15 % slower writing, reading 2-3x slower, first prompt +15 s
   * (shader compile).
   */
  variantFor(gpu: Pick<GpuInfo, "vendor" | "computeCap" | "name" | "deviceId">, backend: Backend = "auto", platform: NodeJS.Platform = process.platform): RuntimeVariant {
    if (platform === "darwin") return "metal";
    const family = backend === "vulkan" ? null : ROCM.familyFor(gpu, platform);
    if (family && (backend === "rocm" || ROCM.byDefault.includes(family))) return `rocm-${family}`;
    if (backend === "vulkan" || gpu.vendor !== "nvidia") return "vulkan";
    if (gpu.computeCap >= 12) return "cuda-13.5";
    return platform === "win32" ? "cuda-12.4" : "cuda-12.8";
  },
  /** Release archives: the engine, plus NVIDIA's CUDA libraries for the CUDA builds. */
  assets(variant: RuntimeVariant, platform: NodeJS.Platform = process.platform): string[] {
    const { tag } = RUNTIME;
    if (variant === "metal") return [`llama-${tag}-bin-macos-arm64.tar.gz`];
    if (isRocm(variant)) return [ROCM.asset(variant)];
    if (platform === "win32") {
      const engine = `llama-${tag}-bin-win-${variant}-x64.zip`;
      return variant === "vulkan" ? [engine] : [engine, `cudart-llama-bin-win-${variant}-x64.zip`];
    }
    const engine = `llama-${tag}-bin-ubuntu-${variant}-x64.tar.gz`;
    return variant === "vulkan" ? [engine] : [engine, `cudart-llama-${tag}-bin-ubuntu-${variant}-x64.tar.gz`];
  },
  /** Approximate download, shown before it starts (MB). */
  downloadMb(variant: RuntimeVariant): number {
    if (isRocm(variant)) return ROCM.families[ROCM.family(variant)].sizeMb;
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
    description: "Permet à l'agent d'ouvrir, tester des pages web et y télécharger des fichiers. Le navigateur conseillé.",
    tokens: 900,
    enabledByDefault: false,
    requires: "npx",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.85"],
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    description: "Inspecte une page dans Chrome : console, réseau, performances. Pour déboguer un site ; à ne pas cumuler avec Playwright.",
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
