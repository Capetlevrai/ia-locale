import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { EngineStatus, GpuInfo } from "../shared/rpc";
import type { LocalSettings } from "../shared/settings";
import type { CatalogModel, RuntimeVariant } from "./catalog";
import { detectGpu, virtualMemory, vulkanDevice } from "./hardware";
import { ENGINE_PORT, IS_WINDOWS, paths } from "./paths";

export interface EnginePlan {
  model: CatalogModel;
  exe: string;
  variant: RuntimeVariant;
  speculative: "none" | "mtp" | "dflash";
  vision: boolean;
  /** Vision projector on the CPU: no VRAM, slower image reading. */
  visionOnCpu: boolean;
  /** Fixed context, or null to let llama.cpp --fit size it to free VRAM. */
  ctx: number | null;
  /** Budget mode: the engine may use at most this much VRAM. */
  budgetMiB: number | null;
  revision: string;
  /** Sampling temperature: user override or the model's recommended value. */
  temperature: number;
}

const LOG_LINES = 40;

let child: ChildProcess | null = null;
let current: EnginePlan | null = null;
let starting: Promise<void> | null = null;
const status: EngineStatus = {
  state: "stopped",
  modelId: null,
  ctx: null,
  speculative: null,
  vision: false,
  vramBudgetMiB: null,
  vramUsedMiB: null,
  notice: null,
  error: null,
  logTail: [],
  appliedRevision: null,
};

export function engineStatus(): EngineStatus {
  return status;
}

export function currentPlan(): EnginePlan | null {
  return current;
}

export function modelPath(localName: string): string {
  return join(paths.models, localName);
}

/** Resolve the user's choices against what the model and disk allow. */
export function makePlan(model: CatalogModel, exe: string, variant: RuntimeVariant, settings: LocalSettings, revision: string): EnginePlan {
  const dflashReady = !!model.dflash && existsSync(modelPath(model.dflash.localName));
  let speculative: EnginePlan["speculative"];
  switch (settings.speculative) {
    case "none":
      speculative = "none";
      break;
    case "dflash":
      speculative = dflashReady ? "dflash" : model.mtp ? "mtp" : "none";
      break;
    default:
      speculative = model.mtp ? "mtp" : "none";
  }
  // DFlash drafts break on image inputs, so it always runs text-only.
  const vision = settings.vision && !!model.mmproj && speculative !== "dflash" && existsSync(modelPath(model.mmproj.localName));
  return {
    model,
    exe,
    variant,
    speculative,
    vision,
    visionOnCpu: vision && settings.visionOnCpu,
    ctx: settings.contextMode === "manual" ? settings.contextTokens : null,
    budgetMiB: settings.contextMode === "budget" && settings.vramBudgetGb > 0 ? Math.round(settings.vramBudgetGb * 1024) : null,
    revision,
    temperature: settings.temperature ?? model.sampling.temp,
  };
}

const MIB = 1024 * 1024;
/** Compute buffers at -b 2048 -ub 512 (ub 128 measured 700; ub 512 costs ~300 more). */
const OVERHEAD_MIB = 1000;
/** CUDA context memory --fit does not account for: measured usage ran ~0.5 GiB over the target. */
const FIT_UNACCOUNTED_MIB = 512;
/** --fit never goes below this context. */
export const MIN_CTX = 16384;
/** Context a MoE model keeps by moving experts to the CPU rather than shrinking it. */
export const MOE_CTX = 65536;
/** MoE weights that stay on the GPU when experts move to the CPU (attention, shared experts). */
const MOE_GPU_MIB = 2048;

/** VRAM the weights take: model, plus vision projector and DFlash draft when used. */
export function weightsMiB(model: CatalogModel, vision: boolean, dflash: boolean): number {
  const bytes = model.main.size + (vision && model.mmproj ? model.mmproj.size : 0) + (dflash && model.dflash ? model.dflash.size : 0);
  return Math.ceil(bytes / MIB);
}

/** Context that fits in a VRAM budget with every weight on the GPU. */
function gpuOnlyCtx(model: CatalogModel, budgetMiB: number, vision: boolean, dflash: boolean): number {
  const kvMiB = budgetMiB - weightsMiB(model, vision, dflash) - OVERHEAD_MIB;
  return Math.max(0, Math.floor((kvMiB * 1024) / model.kvKiBPerToken / 1024) * 1024);
}

/** True when a MoE model should move experts to the CPU to keep MOE_CTX of context. */
export function moeOffload(model: CatalogModel, budgetMiB: number, vision: boolean, dflash: boolean): boolean {
  return !!model.moe && gpuOnlyCtx(model, budgetMiB, vision, dflash) < MOE_CTX;
}

/** Context that fits in a VRAM budget. An estimate: llama.cpp --fit decides at launch. */
export function estimateCtx(model: CatalogModel, budgetMiB: number, vision: boolean, dflash: boolean): number {
  return moeOffload(model, budgetMiB, vision, dflash) ? MOE_CTX : gpuOnlyCtx(model, budgetMiB, vision, dflash);
}

/** Smallest budget that holds the model with the minimum context. */
export function minBudgetMiB(model: CatalogModel, vision: boolean, dflash: boolean): number {
  if (model.moe) {
    const projector = vision && model.mmproj ? Math.ceil(model.mmproj.size / MIB) : 0;
    return MOE_GPU_MIB + projector + OVERHEAD_MIB + Math.ceil((MOE_CTX * model.kvKiBPerToken) / 1024);
  }
  return weightsMiB(model, vision, dflash) + OVERHEAD_MIB + Math.ceil((MIN_CTX * model.kvKiBPerToken) / 1024);
}

function buildArgs(plan: EnginePlan, marginMiB: number, offload: boolean): string[] {
  const kv = plan.model.kvCacheType ?? "q8_0";
  const { model } = plan;
  const args = [
    "-m", modelPath(model.main.localName),
    "--host", "127.0.0.1",
    "--port", String(ENGINE_PORT),
    "--alias", model.id,
    "--no-webui",
    "-fa", "on",
    "-ctk", kv, "-ctv", kv,
    "-np", "1",
    // Bench 2026-10-17 (Swift IQ4_XS, 34K prompt): ub 512 reads context 20% faster
    // than ub 128 for ~7K less context; ub 1024 adds nothing.
    "-b", "2048", "-ub", "512",
    // RAM: a model fully on the GPU keeps no mapped copy in RAM (14 GB -> 1 GB). MoE experts
    // left on the CPU are read from the mapped file instead: copied, they counted ~10 GB
    // against Windows' commit limit on a 10 GB card (laptop engine crashed at 2.6 GB free).
    // Keep 4 context checkpoints instead of 32 (~+0.45 GB each on Qwen3.8 hybrids, which
    // pushed a 31 GB PC to the edge after one session), and no extra RAM prompt cache:
    // with one slot the prefix is reused from the live context anyway.
    "--load-mode", model.moe && (offload || plan.ctx !== null) ? "mmap" : "none",
    "--ctx-checkpoints", "4",
    "--cache-ram", "0",
    "--no-cache-idle-slots",
    "-t", String(Math.min(8, Math.max(2, Math.floor(cpus().length / 2)))),
    "--jinja",
    "--reasoning", "on",
    "--reasoning-format", "deepseek",
    "--reasoning-budget", "-1",
    "--reasoning-preserve",
    "--temp", String(plan.temperature),
    "--top-p", String(model.sampling.topP),
    "--top-k", String(model.sampling.topK),
    "--min-p", String(model.sampling.minP),
  ];

  if (model.moe && (offload || plan.ctx !== null)) {
    // MoE: the context is fixed and --fit moves expert weights to the CPU until
    // `marginMiB` stays free. Attention stays on the GPU (12 GB card: 101 -> 133 tok/s with MTP).
    args.push("-c", String(plan.ctx ?? MOE_CTX), "--fit", "on", "--fit-target", String(marginMiB));
  } else if (plan.ctx !== null) {
    // -ngl 99 pins every layer on the GPU: a dense model spilled to the CPU runs 5-10x slower.
    args.push("-ngl", "99");
    args.push("-c", String(plan.ctx), "--fit", "off");
  } else {
    // Context left unset: --fit shrinks it until `marginMiB` of VRAM stays free.
    args.push("-ngl", "99");
    args.push("--fit", "on", "--fit-target", String(marginMiB), "--fit-ctx", String(MIN_CTX));
  }

  if (plan.vision && model.mmproj) {
    args.push("--mmproj", modelPath(model.mmproj.localName));
    if (plan.visionOnCpu) args.push("--no-mmproj-offload", "--image-max-tokens", String(CPU_IMAGE_TOKENS));
  } else {
    args.push("--no-mmproj");
  }

  if (plan.speculative === "mtp") {
    args.push("--spec-type", "draft-mtp", "--spec-draft-n-max", "3", "-ctkd", kv, "-ctvd", kv);
  } else if (plan.speculative === "dflash" && model.dflash) {
    args.push(
      "--spec-type", "draft-dflash",
      "--spec-draft-n-max", String(model.dflash.draftMax),
      "-md", modelPath(model.dflash.localName),
      "-ngld", "999",
      "-ctkd", kv, "-ctvd", kv,
    );
  }
  return args;
}

function pushLog(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    status.logTail.push(line);
  }
  if (status.logTail.length > LOG_LINES) status.logTail.splice(0, status.logTail.length - LOG_LINES);
}

async function waitHealthy(proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`llama-server s'est arrêté (code ${proc.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Le modèle met trop de temps à charger");
}

async function readContext(): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/props`);
    const props = (await res.json()) as { default_generation_settings?: { n_ctx?: number } };
    return props.default_generation_settings?.n_ctx ?? null;
  } catch {
    return null;
  }
}

/** Kept free in Windows' virtual memory for the agent, browser and system. */
const VM_SAFETY_MIB = 3072;
/** VRAM given up on the automatic retry after a memory crash. */
const RETRY_STEP_MIB = 2048;
/** 0xC0000409: abort raised by GGML_ASSERT when a host allocation fails. */
const MEMORY_EXIT_CODES = new Set([3221226505]);
/**
 * --fit's estimate depends on driver and CUDA version: on an RTX 5080 Laptop it
 * left 1 GB more free than asked (21K context instead of ~40K). When at least this
 * much is left over after loading, relaunch once with the margin corrected.
 */
const CALIBRATE_MIN_MIB = 768;
/** Part of the leftover kept anyway: some buffers are only allocated on the first request. */
const CALIBRATE_KEEP_MIB = 384;
/**
 * --fit misses by about 1 GB at most. A larger correction means the measure was wrong
 * (model split over two cards: the correction grew to 25 GB): it is never applied.
 */
const CALIBRATE_MAX_MIB = 3072;
/**
 * Below this an agent can't finish a real task (Tetris bench: no file written at 16-22K).
 * Vision on the card stays the default even then (RTX 5080 16 GB driving the screen: 30K
 * with it, 55K without): the status only points to the CPU option.
 */
const VISION_MIN_CTX = 32768;
/**
 * Image size cap with the projector on the CPU (Swift IQ3, Ryzen 9800X3D): a 2398x1600
 * screenshot took 51 s at its full 3776 tokens, 8 s at 1024 and still read well.
 */
const CPU_IMAGE_TOKENS = 1024;

/** Projector on the card: what the VRAM maths must count. */
export function visionOnGpu(plan: Pick<EnginePlan, "vision" | "visionOnCpu">): boolean {
  return plan.vision && !plan.visionOnCpu;
}

function calibrationKey(plan: EnginePlan, gpuName: string): string {
  // --fit misses by a different amount on each engine (CUDA keys predate Vulkan).
  const engine = plan.variant === "vulkan" ? ["vulkan"] : [];
  return [gpuName, plan.model.id, visionOnGpu(plan) ? "vision" : "texte", plan.speculative, ...engine].join("|");
}

function readCalibration(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(paths.calibration, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function storedAdjust(key: string): number {
  const adjustMiB = readCalibration()[key] ?? 0;
  return adjustMiB > 0 && adjustMiB <= CALIBRATE_MAX_MIB ? adjustMiB : 0;
}

function saveCalibration(key: string, adjustMiB: number): void {
  const all = readCalibration();
  if (adjustMiB > 0) all[key] = adjustMiB;
  else delete all[key];
  try {
    writeFileSync(paths.calibration, JSON.stringify(all, null, 2));
  } catch {
    // Only an optimisation.
  }
}

interface Pin {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Keep the engine on the card detectGpu measured: the other cards stay invisible to it. */
async function pinTo(plan: EnginePlan, gpu: GpuInfo | null): Promise<Pin> {
  if (!gpu) return { args: [] };
  if (plan.variant === "vulkan") {
    const device = await vulkanDevice(plan.exe, gpu.name);
    return { args: device ? ["--device", device] : [] };
  }
  if (gpu.vendor !== "nvidia" || gpu.index < 0) return { args: [] };
  // PCI_BUS_ID makes CUDA number the cards like nvidia-smi (by default the fastest comes first).
  return { args: [], env: { ...process.env, CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: String(gpu.index) } };
}

/**
 * Start llama-server once and wait for it to be ready, on the card `pin` selects.
 * `calibrationKey` is dropped if it later dies for lack of memory.
 */
async function launch(
  plan: EnginePlan,
  marginMiB: number,
  freeBefore: number | null,
  offload: boolean,
  pin: Pin,
  calibrationKey: string,
): Promise<"ok" | "memory" | "error"> {
  const args = [...buildArgs(plan, marginMiB, offload), ...pin.args];
  const log = createWriteStream(join(paths.logs, "llama-server.log"), { flags: "w" });
  log.write(`"${plan.exe}" ${args.join(" ")}\n\n`);
  const proc = spawnProcess(plan.exe, args, { cwd: dirname(plan.exe), stdio: "pipe", windowsHide: true, env: pin.env });
  child = proc;
  writeFileSync(paths.state, JSON.stringify({ enginePid: proc.pid }));
  let memoryFailure = false;
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      const text = chunk.toString("utf8");
      // CUDA, Vulkan (vk::Result), then Metal wording.
      if (/mem_buffer != NULL|out of memory|cudaMalloc failed|failed to allocate|allocation failed|OutOf(Device|Host)Memory|OutOfMemory|Insufficient Memory/i.test(text)) memoryFailure = true;
      pushLog(text);
    });
  }
  proc.on("exit", (code) => {
    log.end();
    if (code !== null && MEMORY_EXIT_CODES.has(code)) memoryFailure = true;
    if (child !== proc) return;
    child = null;
    // Out of memory on a request: the calibrated margin was too tight for this PC.
    if (status.state === "ready" && memoryFailure && calibrationKey) saveCalibration(calibrationKey, 0);
    if (status.state !== "stopped") {
      status.state = "error";
      status.error = `llama-server s'est arrêté (code ${code}). Voir ${join(paths.logs, "llama-server.log")}`;
    }
  });

  try {
    await waitHealthy(proc, 15 * 60_000);
    status.ctx = (await readContext()) ?? plan.ctx;
    const freeAfter = (await detectGpu())?.vramFreeMiB ?? null;
    status.vramUsedMiB = freeBefore !== null && freeAfter !== null ? freeBefore - freeAfter : null;
    status.state = "ready";
    return "ok";
  } catch (error) {
    status.state = "error";
    status.error = error instanceof Error ? error.message : String(error);
    if (child === proc) {
      child = null;
      if (proc.exitCode === null) await terminateProcess(proc);
    }
    return memoryFailure ? "memory" : "error";
  }
}

export function start(plan: EnginePlan): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    await stop();
    current = plan;
    Object.assign(status, {
      state: "starting",
      modelId: plan.model.id,
      ctx: plan.ctx,
      speculative: plan.speculative,
      vision: plan.vision,
      vramBudgetMiB: plan.budgetMiB,
      vramUsedMiB: null,
      notice: null,
      error: null,
      logTail: [],
      appliedRevision: plan.revision,
    } satisfies EngineStatus);

    // Let the driver release the previous engine's memory before measuring.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const gpuInfo = await detectGpu();
    const freeBefore = gpuInfo?.vramFreeMiB ?? null;
    // What the engine may put in VRAM: the budget, or nearly all free VRAM in auto mode.
    let budgetMiB = plan.budgetMiB ?? (freeBefore !== null ? freeBefore - 1024 : null);
    const minMiB = minBudgetMiB(plan.model, visionOnGpu(plan), plan.speculative === "dflash");

    // Windows reserves virtual memory as large as the VRAM the engine uses. When
    // RAM + paging file can't cover it, lower the budget instead of crashing.
    const vm = await virtualMemory();
    if (vm && budgetMiB !== null) {
      const room = vm.limitMiB - vm.usedMiB - VM_SAFETY_MIB;
      if (room < budgetMiB && room >= minMiB) {
        status.notice = `Mémoire de Windows limitée : la carte est utilisée à ${(room / 1024).toFixed(0)} Go au lieu de ${(budgetMiB / 1024).toFixed(0)} Go (contexte un peu réduit).`;
        budgetMiB = room;
      } else if (room < minMiB) {
        status.notice = "Mémoire de Windows très limitée : fermer quelques applications ou redémarrer le PC aidera.";
      }
    }

    // Automatic context only: give back the VRAM --fit left unused last time on this GPU.
    const calibrate = plan.ctx === null && budgetMiB !== null && freeBefore !== null && !!gpuInfo;
    const key = gpuInfo ? calibrationKey(plan, gpuInfo.name) : "";
    let adjustMiB = calibrate ? storedAdjust(key) : 0;
    let recalibrated = false;
    let memoryRetried = false;
    const pin = await pinTo(plan, gpuInfo);

    // One automatic retry with less VRAM if the engine dies for lack of memory.
    for (;;) {
      const marginMiB = budgetMiB !== null && freeBefore !== null ? Math.max(512, freeBefore - budgetMiB + FIT_UNACCOUNTED_MIB - adjustMiB) : 1024;
      const offload = plan.ctx === null && budgetMiB !== null && moeOffload(plan.model, budgetMiB, visionOnGpu(plan), plan.speculative === "dflash");
      if (offload && !status.notice) {
        status.notice = "Une partie du modèle tourne sur le processeur pour garder 64K de contexte (modèle MoE : la vitesse reste bonne).";
      }
      const outcome = await launch(plan, marginMiB, freeBefore, offload, pin, calibrate ? key : "");
      if (outcome === "ok") {
        const leftover = calibrate && budgetMiB !== null && status.vramUsedMiB !== null ? budgetMiB - status.vramUsedMiB : 0;
        if (!recalibrated && leftover >= CALIBRATE_MIN_MIB && adjustMiB + leftover - CALIBRATE_KEEP_MIB <= CALIBRATE_MAX_MIB) {
          recalibrated = true;
          adjustMiB += leftover - CALIBRATE_KEEP_MIB;
          saveCalibration(key, adjustMiB);
          status.state = "starting";
          await stop();
          status.state = "starting";
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        if (visionOnGpu(plan) && status.ctx !== null && status.ctx < VISION_MIN_CTX && !status.notice) {
          status.notice =
            `La vision prend environ 1 Go sur la carte : il reste ${Math.round(status.ctx / 1024)}K de contexte, ` +
            "juste pour les longues tâches. Pour en avoir plus : « Vision sur le processeur » (images beaucoup plus lentes) " +
            "ou couper la vision, dans IA locale.";
        }
        return;
      }
      if (outcome === "memory" && adjustMiB > 0) {
        // The corrected margin was too tight: back to --fit's own estimate.
        adjustMiB = 0;
        recalibrated = true;
        saveCalibration(key, 0);
        status.state = "starting";
        status.error = null;
        continue;
      }
      if (outcome === "memory" && !memoryRetried && budgetMiB !== null && budgetMiB - RETRY_STEP_MIB >= minMiB) {
        memoryRetried = true;
        budgetMiB -= RETRY_STEP_MIB;
        status.notice = `Mémoire limitée : relancé automatiquement avec ${(budgetMiB / 1024).toFixed(0)} Go de VRAM.`;
        status.state = "starting";
        status.error = null;
        continue;
      }
      if (outcome === "memory") {
        status.error = "Pas assez de mémoire pour charger ce modèle. Ferme quelques applications, redémarre l'ordinateur, ou choisis un modèle plus petit.";
      }
      await stop(true);
      throw new Error(status.error ?? "Le moteur n'a pas démarré");
    }
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export async function stop(keepError = false): Promise<void> {
  const proc = child;
  child = null;
  if (!keepError) {
    status.state = "stopped";
    status.error = null;
  }
  if (proc && proc.exitCode === null) await terminateProcess(proc);
}

export function isReady(): boolean {
  return status.state === "ready" && child !== null;
}

/**
 * Kill a llama-server this plugin started before a daemon restart. Only the
 * PID we recorded, and only if it still runs our runtime: never touch other
 * llama-server instances on the machine.
 */
export async function killOrphan(): Promise<void> {
  if (!existsSync(paths.state)) return;
  let pid: number | undefined;
  try {
    pid = (JSON.parse(readFileSync(paths.state, "utf8")) as { enginePid?: number }).enginePid;
  } catch {
    return;
  }
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execCommand(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`],
        { timeout: 15_000 },
      );
      if (stdout.trim().toLowerCase().startsWith(paths.runtime.toLowerCase())) {
        await execCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000 });
      }
    } else {
      // Full command line; it starts with the engine's path.
      const { stdout } = await execCommand("ps", ["-p", String(pid), "-o", "command="], { timeout: 15_000 });
      if (stdout.trim().startsWith(paths.runtime)) process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}
