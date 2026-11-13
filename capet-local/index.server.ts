import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyRpc,
  cancelDownloadRpc,
  downloadModelRpc,
  installRuntimeRpc,
  statsRpc,
  statusRpc,
  stopRpc,
  type GpuInfo,
  type ModelTier,
  type Status,
} from "./shared/rpc";
import { localSettings, LocalSettingsSchema, type LocalSettings } from "./shared/settings";
import { findModel, MCPS, MODELS, OMP_BASE_TOKENS, RUNTIME, type CatalogModel, type RuntimeVariant } from "./server/catalog";
import { cancelJob, hfUrl, jobProgress, startJob } from "./server/download";
import * as engine from "./server/engine";
import { callsInFlight, gatewayError, recentCalls, startGateway, stopGateway } from "./server/gateway";
import * as stats from "./server/stats";
import { detectGpu, findOmp, hasNpx, ompVersion } from "./server/hardware";
import { LOCAL_MODEL_ID, OMP_CLOUD_KEYS, OMP_CONFIG, writeOmpConfig } from "./server/omp";
import { GATEWAY_PORT, paths, PROVIDER_ID } from "./server/paths";
import { findServerExe, installRuntime, runtimeDownload, runtimeLabel } from "./server/runtime";
import { latestRelease } from "./server/update";
import { VERSION } from "./shared/version";

/** Paseo only provides zod and @getpaseo/plugin* to plugins, so the client type comes from the SDK. */
type PaseoApi = PluginHandlerContext["paseo"];

const NO_GPU = "Aucune carte graphique détectée";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(localSettings);

  /** A Paseo client, from any RPC or hook (the plugin gets none at startup). */
  let paseoClient: PaseoApi | null = null;
  /** model|ctx last written to OMP's config. */
  let advertised: string | null = null;
  /** Re-probe owed to Paseo: at plugin start, or a config change before any client showed up. */
  let refreshPending = true;
  /**
   * The « IA locale » agent must exist in Paseo without anyone clicking Apply: a
   * fresh install driven only by agents or scripts never had it registered.
   */
  let providerRegistered = false;
  function rememberClient(paseo: PaseoApi): void {
    paseoClient = paseo;
    if (!providerRegistered) {
      providerRegistered = true;
      // Paseo probes the provider right away: OMP's config must exist first.
      void (existsSync(OMP_CONFIG) ? Promise.resolve() : plan().then(syncAgentConfig).catch(() => {}))
        .then(() => registerProvider(paseo))
        .then(() => refreshProvider(paseo))
        .catch(() => {
          providerRegistered = false; // e.g. OMP not installed yet: try again later
        });
      refreshPending = false;
    } else if (refreshPending) {
      refreshPending = false;
      void refreshProvider(paseo);
    }
  }

  /** Engine build for this card: the saved `backend` setting can force Vulkan. */
  async function runtimeVariant(card: GpuInfo): Promise<RuntimeVariant> {
    return RUNTIME.variantFor(card, (await readSettings()).values.backend);
  }

  // Short enough for the sidebar's live VRAM meter, which polls the status.
  let gpuCache: { at: number; gpu: GpuInfo | null } | null = null;
  async function gpu(): Promise<GpuInfo | null> {
    if (!gpuCache || Date.now() - gpuCache.at > 2_000) gpuCache = { at: Date.now(), gpu: await detectGpu() };
    return gpuCache.gpu;
  }

  let ompCache: { command: string[] | null; version: string | null } | null = null;
  async function omp() {
    if (!ompCache?.command) {
      const command = await findOmp();
      ompCache = { command, version: command ? await ompVersion(command) : null };
    }
    return ompCache;
  }

  let npx: boolean | null = null;

  async function readSettings(): Promise<{ values: LocalSettings; revision: string }> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Réglages invalides : ${state.error}`);
    return { values: state.values, revision: state.revision };
  }

  function modelInstalled(model: CatalogModel): boolean {
    return existsSync(engine.modelPath(model.main.localName)) && (!model.mmproj || existsSync(engine.modelPath(model.mmproj.localName)));
  }

  function enabledMcps(values: LocalSettings) {
    return MCPS.filter((m) => values.mcp[m.id] ?? m.enabledByDefault);
  }

  /**
   * `overrides` lets the test API try other settings without touching the saved ones.
   * `modelId` is the model an agent asked for, when it is not the one saved in the settings.
   */
  async function plan(overrides: Partial<LocalSettings> = {}, modelId?: string): Promise<engine.EnginePlan> {
    const saved = await readSettings();
    const values = { ...saved.values, ...overrides, ...(modelId ? { modelId } : {}) };
    const revision = Object.keys(overrides).length > 0 ? `${saved.revision}+test` : saved.revision;
    const model = findModel(values.modelId);
    if (!model) throw new Error("Aucun modèle choisi");
    if (!modelInstalled(model)) throw new Error(`${model.label} n'est pas téléchargé`);
    const card = await gpu();
    if (!card) throw new Error(NO_GPU);
    const variant = RUNTIME.variantFor(card, values.backend);
    const exe = findServerExe(variant);
    if (!exe) throw new Error("Le moteur llama.cpp n'est pas installé");
    const next = engine.makePlan(model, exe, variant, values, revision);
    if (next.budgetMiB !== null) {
      const min = engine.minBudgetMiB(model, engine.visionOnGpu(next), next.speculative === "dflash");
      if (next.budgetMiB < min) {
        throw new Error(
          `${model.label} ne tient pas dans ${values.vramBudgetGb} Go : il faut au moins ${Math.ceil(min / 1024)} Go` +
            (engine.visionOnGpu(next) ? " (ou désactive la vision)." : "."),
        );
      }
    }
    return next;
  }

  /** Largest context announced for a model that was never loaded with the current settings. */
  const ESTIMATE_MAX_CTX = 131072;

  /** Context each model got the last time it was loaded with these settings (model|vision|accel|mode -> tokens). */
  const contextsFile = join(paths.base, "contexts.json");
  function readContexts(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(contextsFile, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }
  function contextKey(p: engine.EnginePlan): string {
    return [p.model.id, engine.visionOnGpu(p) ? "vision" : "texte", p.speculative, p.ctx ?? "auto", p.budgetMiB ?? "libre"].join("|");
  }

  /**
   * Context to announce for a model: measured if it is the loaded one, else what it got
   * last time with these settings, else an estimate (never above what the card can hold:
   * an agent that believes in more context than the engine has ends in an error).
   */
  function contextFor(p: engine.EnginePlan, card: GpuInfo | null): number {
    const loaded = engine.currentPlan();
    const live = engine.engineStatus();
    if (loaded && loaded.model.id === p.model.id && live.state === "ready" && live.ctx) return live.ctx;
    const remembered = readContexts()[contextKey(p)];
    if (remembered) return remembered;
    if (p.ctx !== null) return p.ctx;
    const budgetMiB = p.budgetMiB ?? (card ? card.vramTotalMiB - 2048 : null);
    const estimate = budgetMiB !== null ? engine.estimateCtx(p.model, budgetMiB, engine.visionOnGpu(p), p.speculative === "dflash") : 0;
    // Capped: the estimate ignores what else uses the card, and no model here is trained
    // beyond 262K. Announcing less than the engine gives only compacts a little early.
    return Math.min(ESTIMATE_MAX_CTX, Math.max(engine.MIN_CTX, estimate || 32768));
  }

  /**
   * Tell OMP which model answers: `p` is the plan just applied or loaded. Agents see a
   * single model whose name is this one's (omp.ts, LOCAL_MODEL_ID), with the context the
   * engine gives it.
   */
  async function syncAgentConfig(p: engine.EnginePlan): Promise<void> {
    const { values } = await readSettings();
    const card = await gpu();
    const live = engine.engineStatus();
    if (live.state === "ready" && live.ctx && engine.currentPlan() === p) {
      const all = readContexts();
      if (all[contextKey(p)] !== live.ctx) {
        all[contextKey(p)] = live.ctx;
        try {
          writeFileSync(contextsFile, JSON.stringify(all, null, 2));
        } catch {
          // Only spares an estimate next time.
        }
      }
    }
    const ctx = contextFor(p, card);
    writeOmpConfig([{ model: p.model, ctx, temperature: p.temperature }], p.model.id, enabledMcps(values), {
      local: values.localCompaction,
      percent: values.compactPercent,
    });
    // Paseo caches the provider's model list: re-probe when the model or its context
    // changes, so every agent's model picker shows the name of the model that answers.
    const exposed = `${p.model.id}|${ctx}`;
    if (exposed !== advertised) {
      advertised = exposed;
      if (paseoClient) await refreshProvider(paseoClient);
      else refreshPending = true;
    }
    // Loaded, so the context is the real one: open agents must take it.
    if (engine.isReady() && engine.currentPlan() === p && exposed !== agentsOpenedWith) {
      agentsOpenedWith = exposed;
      if (paseoClient) void reopenIdleAgents(paseoClient);
    }
  }

  /** Model and context the open agents were last reopened for. */
  let agentsOpenedWith: string | null = null;

  /**
   * An agent reads its model's settings (context size, thinking levels) when its session
   * opens. After another model is loaded, an agent still open would keep the old context:
   * larger than the new model's, a long conversation ends in an engine error. Reopen the
   * local agents used since the plugin started, when they are idle (a reload interrupts a
   * running turn); a busy one keeps its settings until the next change. Its conversation
   * is kept. Older Paseo versions have no reload: nothing happens there.
   */
  async function reopenIdleAgents(paseo: PaseoApi): Promise<void> {
    for (const { agentId, current } of stats.agentStats()) {
      if (current) continue;
      try {
        const handle = paseo.agents.ref(agentId) as { reload?: () => Promise<unknown> };
        await handle.reload?.();
      } catch (error) {
        // Deleted or archived since: nothing to reopen.
        console.error(`[capet-local] agent ${agentId} not reopened`, error);
      }
    }
  }

  /**
   * The engine ready, on the model chosen in IA locale: that is the only place a model is
   * chosen, whatever name an agent sends (agents opened by older versions send a model id).
   * Returns the id of the model that serves.
   */
  async function ensureEngine(_requested: string | null = null, _idle?: () => boolean, gone: () => boolean = () => false): Promise<string> {
    const loaded = engine.currentPlan();
    if (engine.isReady() && loaded) return loaded.model.id;
    const next = await plan();
    // The agent gave up while waiting: don't load a model for a call nobody reads.
    if (gone()) return next.model.id;
    await engine.start(next);
    await syncAgentConfig(next);
    return next.model.id;
  }

  /** The "IA locale" entry of Paseo's agents.providers (also written by install.ps1). */
  async function providerEntry(): Promise<Record<string, unknown>> {
    const ompInfo = await omp();
    if (!ompInfo.command) throw new Error("Oh My Pi (omp) n'est pas installé");
    return {
      extends: "omp",
      label: "IA locale",
      description: "Oh My Pi sur un modèle qui tourne sur ta carte graphique (Capet Local).",
      command: [...ompInfo.command, "--config", OMP_CONFIG],
      env: {
        PI_CODING_AGENT_DIR: paths.omp,
        OMP_SKIP_SETUP: "1",
        OMP_PROFILE: "",
        ...Object.fromEntries(OMP_CLOUD_KEYS.map((key) => [key, ""])),
      },
      enabled: true,
    };
  }

  async function registerProvider(paseo: PaseoApi): Promise<void> {
    await paseo.config.patch({ providers: { [PROVIDER_ID]: await providerEntry() } });
  }

  /** Effort levels as OMP sends them to the Qwen template. */
  const REASONING_BUDGETS: Record<string, number> = { low: 4096, medium: 12288, high: 32768, xhigh: 32768 };

  async function reasoningBudget(effort: string | null): Promise<number | null> {
    const { values } = await readSettings();
    if (!values.reasoningLimit) return null;
    return REASONING_BUDGETS[effort ?? "medium"] ?? REASONING_BUDGETS.medium;
  }

  /**
   * Scripted tests (tools/bench.ps1). `apply` takes settings overrides that
   * are NOT saved, waits for the model, and returns what was measured.
   */
  async function admin(method: string, path: string, body: unknown): Promise<unknown> {
    if (method === "GET" && path === "status") return buildStatus();
    if (method === "GET" && path === "stats") return { agents: stats.agentStats() };
    if (method === "GET" && path === "calls") return { inFlight: callsInFlight(), recent: recentCalls() };
    // The installer registers the provider itself: no Paseo client exists before the app opens.
    if (method === "GET" && path === "provider") return { id: PROVIDER_ID, entry: await providerEntry() };
    if (method === "POST" && path === "download-model") {
      const { modelId, part = "model" } = body as { modelId?: string; part?: "model" | "dflash" };
      const model = findModel(modelId ?? null);
      if (!model) throw new Error(`Modèle inconnu : ${modelId}`);
      const files = part === "dflash" ? (model.dflash ? [model.dflash] : []) : [model.main, ...(model.mmproj ? [model.mmproj] : [])];
      void startJob(
        `${part}:${model.id}`,
        model.label,
        files.map((f) => ({ url: hfUrl(f), dest: engine.modelPath(f.localName), size: f.size, sha256: f.sha256 })),
      );
      return { started: true, files: files.map((f) => f.localName) };
    }
    if (method === "POST" && path === "install-runtime") {
      const card = await gpu();
      if (!card) throw new Error(NO_GPU);
      const variant = await runtimeVariant(card);
      await installRuntime(variant);
      return { installed: !!findServerExe(variant), download: runtimeDownload() };
    }
    if (method === "POST" && path === "stop") {
      await engine.stop();
      return engine.engineStatus();
    }
    if (method === "POST" && path === "apply") {
      // .partial() still fills defaults for absent keys: keep only the keys sent.
      const sent = body && typeof body === "object" ? Object.keys(body) : [];
      const parsed = LocalSettingsSchema.partial().parse(body);
      const overrides = Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.includes(key))) as Partial<LocalSettings>;
      const next = await plan(overrides);
      try {
        await engine.start(next);
      } catch {
        // Status carries the error and log tail.
      }
      // A test run must not leave its model/context in OMP's config: agents
      // created afterwards would start with the test's context window.
      if (engine.isReady() && Object.keys(overrides).length === 0) await syncAgentConfig(next);
      return engine.engineStatus();
    }
    throw new Error(`Route inconnue : ${method} /capet/${path}`);
  }

  // --- lifecycle ---------------------------------------------------------

  let lastActivity = Date.now();
  void engine.killOrphan().then(() =>
    startGateway({
      ensureEngine,
      loadedModel: () => (engine.isReady() ? (engine.currentPlan()?.model.id ?? null) : null),
      onActivity: () => (lastActivity = Date.now()),
      admin,
      reasoningBudget,
      engineKey: engine.engineKey,
      vision: () => engine.engineStatus().vision,
      efforts: () => engine.currentPlan()?.model.reasoningEfforts ?? null,
      sampling: () => {
        const p = engine.currentPlan();
        if (!p) return null;
        const { topP, topK, minP } = p.model.sampling;
        return { temperature: p.temperature, top_p: topP, top_k: topK, min_p: minP };
      },
    }),
  );

  const stopWatchingSettings = settings.subscribe(() => {
    const state = engine.engineStatus().state;
    if (state === "ready" || state === "starting") return; // Apply will sync with the loaded model.
    void plan()
      .then(syncAgentConfig)
      .catch(() => {});
  });

  const idleTimer = setInterval(() => {
    void readSettings()
      .then(({ values }) => {
        if (values.idleMinutes > 0 && engine.isReady() && Date.now() - lastActivity > values.idleMinutes * 60_000) {
          void engine.stop();
        }
      })
      .catch(() => {});
  }, 60_000);

  server.before("agent.create", async ({ request }, { paseo }) => {
    rememberClient(paseo);
    if (request.config.provider !== PROVIDER_ID) return;
    // Load the model while OMP boots instead of on its first request.
    lastActivity = Date.now();
    void ensureEngine().catch(() => {});
    // Whatever model the composer remembered (an id from an older version): the one entry.
    request.config.model = `${PROVIDER_ID}/${LOCAL_MODEL_ID}`;
    const { values } = await readSettings();
    if (!values.paseoTools && request.config.mcpServers) {
      const { paseo: _dropped, ...rest } = request.config.mcpServers;
      request.config.mcpServers = rest;
    }
    return request;
  });

  // Turn timing: prompt sent -> final answer, for the composer pill.
  server.on("agent.turn_started", ({ agent }) => {
    if (agent.provider === PROVIDER_ID) stats.turnStarted(agent.id, agent.workspaceId);
  });
  server.on("agent.turn_ended", ({ agent, outcome }) => {
    if (agent.provider === PROVIDER_ID) stats.turnEnded(agent.id, outcome.kind);
  });

  // --- RPC ---------------------------------------------------------------

  /**
   * Paseo caches each provider's probe result per folder and does not retry a
   * failure by itself, so a probe that ran before OMP's config existed keeps
   * showing "Erreur" (on mobile too). Re-probe once per plugin start, on the
   * first RPC that hands us a Paseo client (the stats pill polls every second).
   */
  async function refreshProvider(paseo: PaseoApi): Promise<void> {
    try {
      await paseo.providers.refresh({ providers: [PROVIDER_ID] });
    } catch (error) {
      console.error("[capet-local] provider refresh failed", error);
    }
  }

  server.handle(statsRpc, (_input, { paseo }) => {
    rememberClient(paseo);
    return { agents: stats.agentStats() };
  });

  async function buildStatus(): Promise<Status> {
    const card = await gpu();
    const { values } = await readSettings();
    const variant = card ? RUNTIME.variantFor(card, values.backend) : "cuda-12.4";
    const ompInfo = await omp();
    npx ??= await hasNpx();
    // Cards report a bit under their advertised size (a "16 GB" RTX 5080 shows 15.9):
    // round to the nearest GB so tiers match what buyers know.
    const vramGb = card ? Math.round(card.vramTotalMiB / 1024) : 0;
    const dflash = values.speculative === "dflash";
    // VRAM maths: a projector on the CPU costs none.
    const vision = (m: CatalogModel) => values.vision && !values.visionOnCpu && !dflash && !!m.mmproj;

    const selected = findModel(values.modelId);
    const budgetOptions: Status["budgetOptions"] = [];
    if (selected && card) {
      const min = Math.ceil(engine.minBudgetMiB(selected, vision(selected), dflash) / 1024);
      for (let gb = min; gb <= Math.floor(vramGb); gb++) {
        budgetOptions.push({ gb, estCtx: engine.estimateCtx(selected, gb * 1024, vision(selected), dflash) });
      }
    }

    return {
      gpu: card,
      runtime: {
        installed: !!findServerExe(variant),
        label: runtimeLabel(variant),
        sizeMb: RUNTIME.downloadMb(variant),
        download: runtimeDownload(),
      },
      omp: { installed: !!ompInfo.command, version: ompInfo.version },
      node: npx,
      models: MODELS.map((m) => {
        // Catalog order is quality order: recommend only the first model that fits comfortably.
        const tier: ModelTier =
          vramGb >= m.recommendedVramGb
            ? m === MODELS.find((c) => vramGb >= c.recommendedVramGb)
              ? "recommended"
              : "compatible"
            : vramGb >= m.minVramGb
              ? "tight"
              : "too_big";
        return {
          id: m.id,
          label: m.label,
          technical: m.technical,
          repo: m.main.repo,
          description: m.description,
          sizeBytes: m.main.size + (m.mmproj?.size ?? 0),
          tier,
          installed: modelInstalled(m),
          download: jobProgress(`model:${m.id}`),
          features: { mtp: m.mtp, dflash: !!m.dflash, vision: !!m.mmproj },
          dflashInstalled: !!m.dflash && existsSync(engine.modelPath(m.dflash.localName)),
          dflashDownload: jobProgress(`dflash:${m.id}`),
          minBudgetMiB: engine.minBudgetMiB(m, vision(m), dflash && !!m.dflash),
        };
      }),
      mcp: MCPS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        tokens: m.tokens,
        enabledByDefault: m.enabledByDefault,
        requires: m.requires,
        available: m.requires !== "npx" || npx === true,
      })),
      engine: engine.engineStatus(),
      budgetOptions,
      gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
      gatewayError: gatewayError(),
      callsInFlight: callsInFlight(),
      version: VERSION,
      update: await latestRelease(),
      agentBaseTokens: OMP_BASE_TOKENS,
      dataDir: paths.base,
    };
  }

  server.handle(statusRpc, (_input, { paseo }) => {
    rememberClient(paseo);
    return buildStatus();
  });

  server.handle(downloadModelRpc, ({ modelId, part }) => {
    const model = findModel(modelId);
    if (!model) return { ok: false, message: "Modèle inconnu" };
    const files = part === "dflash" ? (model.dflash ? [model.dflash] : []) : [model.main, ...(model.mmproj ? [model.mmproj] : [])];
    if (files.length === 0) return { ok: false, message: "Rien à télécharger" };
    void startJob(
      `${part}:${modelId}`,
      part === "dflash" ? `DFlash ${model.label}` : model.label,
      files.map((f) => ({ url: hfUrl(f), dest: engine.modelPath(f.localName), size: f.size, sha256: f.sha256 })),
    );
    return { ok: true };
  });

  server.handle(cancelDownloadRpc, ({ modelId }) => {
    cancelJob(`model:${modelId}`);
    cancelJob(`dflash:${modelId}`);
    return { ok: true };
  });

  server.handle(installRuntimeRpc, async () => {
    const card = await gpu();
    if (!card) return { ok: false, message: NO_GPU };
    void installRuntime(await runtimeVariant(card));
    return { ok: true };
  });

  /** Plain-language "how much VRAM will this take" for the Apply button. */
  function vramPlanText(p: engine.EnginePlan, previousUsedMiB: number): string {
    const card = gpuCache?.gpu;
    if (!card) return "";
    const go = (mib: number) => `${(mib / 1024).toFixed(1).replace(".", ",")} Go`;
    const total = go(card.vramTotalMiB);
    if (p.budgetMiB !== null) return `Il utilisera au plus ${go(p.budgetMiB)} de VRAM sur les ${total} de ta carte.`;
    if (p.ctx !== null) return `Contexte fixe de ${p.ctx.toLocaleString("fr-FR")} tokens.`;
    // The model being replaced frees its memory first: count it as available.
    const available = card.vramFreeMiB + previousUsedMiB;
    return `Il prendra presque toute la VRAM disponible (≈ ${go(available - 1024)} sur ${total} ; le système et tes logiciels utilisent le reste), et le contexte s'adapte.`;
  }

  server.handle(applyRpc, async (_input, { paseo }) => {
    rememberClient(paseo);
    const previousUsedMiB = engine.isReady() ? (engine.engineStatus().vramUsedMiB ?? 0) : 0;
    gpuCache = null; // fresh free-VRAM reading for the message
    let next: engine.EnginePlan;
    try {
      next = await plan();
      await gpu();
      // OMP must find its config the moment Paseo probes the new provider;
      // the real context size replaces this estimate once the model is loaded.
      await syncAgentConfig(next);
      await registerProvider(paseo);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    // Loading takes from seconds to minutes: answer now, the UI polls status.
    void engine
      .start(next)
      .then(() => syncAgentConfig(next))
      .then(() => refreshProvider(paseo))
      .catch(() => {});
    return {
      ok: true,
      message: `Chargement de ${next.model.label}. ${vramPlanText(next, previousUsedMiB)}`,
    };
  });

  server.handle(stopRpc, async () => {
    await engine.stop();
    return { ok: true };
  });

  return () => {
    clearInterval(idleTimer);
    stopWatchingSettings();
    stopGateway();
    void engine.stop();
  };
}
