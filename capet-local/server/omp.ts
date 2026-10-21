import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogMcp, CatalogModel } from "./catalog";
import { GATEWAY_PORT, paths, PROVIDER_ID } from "./paths";

export const OMP_CONFIG = join(paths.omp, "config.yml");

/**
 * OMP enables a cloud provider whenever its key is in the environment (a
 * user-level GROQ_API_KEY listed 27 Groq models next to the local one). The
 * agent gets all of them blanked: a local agent must never reach the cloud.
 * List from `omp --help` (OMP 18.8).
 */
export const OMP_CLOUD_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY", "OPENAI_API_KEY",
  "GEMINI_API_KEY", "COPILOT_GITHUB_TOKEN", "AZURE_OPENAI_API_KEY", "GROQ_API_KEY",
  "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "KILO_API_KEY", "MISTRAL_API_KEY",
  "ZAI_API_KEY", "UMANS_AI_CODING_PLAN_API_KEY", "ABLITERATION_API_KEY", "MINIMAX_API_KEY",
  "OPENCODE_API_KEY", "CURSOR_ACCESS_TOKEN", "CLINE_API_KEY", "COMMAND_CODE_API_KEY",
  "CHARM_HYPER_API_KEY", "AI_GATEWAY_API_KEY", "STEPFUN_API_KEY", "HELMCODE_API_KEY",
  "WAFER_SERVERLESS_API_KEY", "YOLO_AUTO_API_KEY", "SINGULARITYAPI_DEV_API_KEY",
  "SINGULARITYAPI_TECH_API_KEY",
];

/** Tokens always left free after the trigger: one big tool result plus a reply. */
const COMPACTION_HEADROOM = 8192;

/**
 * OMP's defaults are tuned for cloud models: compact at ~82-85% of the window,
 * start a background LLM summary 8-32K tokens before that (which queues behind
 * the agent on llama.cpp's single slot), and summarize first. Locally: compact
 * late, drop old tool output first (no model call), summarize only if needed.
 * The trigger is a token count so small contexts still keep 8K of headroom.
 */
function localCompaction(ctx: number, percent: number) {
  const thresholdTokens = Math.max(Math.floor(ctx / 2), Math.min(Math.floor((ctx * percent) / 100), ctx - COMPACTION_HEADROOM));
  return {
    enabled: true,
    thresholdTokens,
    methodOrder: ["shake", "soft"],
    asyncEnabled: false,
    midTurnEnabled: true,
    keepRecentTokens: Math.min(20000, Math.floor(ctx / 4)),
    supersedeReads: true,
    dropUseless: true,
  };
}

/**
 * Write the isolated OMP agent dir: one local model, only the MCPs the user
 * ticked, and every cloud provider disabled so OMP never reaches out.
 */
export function writeOmpConfig(
  model: CatalogModel,
  ctx: number,
  mcps: CatalogMcp[],
  compaction: { local: boolean; percent: number },
  temperature: number,
): void {
  const thinking = model.reasoningEfforts
    ? { mode: "effort", efforts: model.reasoningEfforts, defaultLevel: "medium" }
    : undefined;

  const models = {
    providers: {
      [PROVIDER_ID]: {
        baseUrl: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
        api: "openai-completions",
        auth: "none",
        models: [
          {
            id: model.id,
            name: model.label,
            reasoning: true,
            // Always: with vision off, OMP's own text-only path ends in an English error
            // ("does not support image input"); the gateway swaps images for a note instead.
            input: ["text", "image"],
            // llama.cpp decodes images with stb (PNG/JPEG); WebP only works through ffprobe,
            // missing on a fresh PC: browser screenshots then failed with "400 Failed to load
            // image". "stb" makes OMP send PNG or JPEG instead of WebP.
            imageInputDecoder: "stb",
            contextWindow: ctx,
            // Reasoning and the answer share this cap. 32K (a cloud default) cut a
            // 20 KB file write in half after ~28K tokens of xhigh reasoning, and the
            // agent had to redo it in pieces. Local tokens cost nothing: allow half
            // the window (OMP still shrinks it to whatever space is left).
            maxTokens: Math.min(65536, Math.floor(ctx / 2)),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              ...model.ompCompat,
              extraBody: {
                reasoning_budget_tokens: -1,
                temperature,
                top_p: model.sampling.topP,
                top_k: model.sampling.topK,
                min_p: model.sampling.minP,
                presence_penalty: 0,
                repeat_penalty: 1,
              },
            },
            ...(thinking ? { thinking } : {}),
          },
        ],
      },
    },
  };

  // Every role on the one loaded model: a subagent must never trigger a model swap.
  const roles = ["smol", "slow", "plan", "commit", "tiny", "task", "advisor", "vision", "memory"];
  const config = {
    modelRoles: Object.fromEntries(roles.map((role) => [role, "@default"])),
    enabledModels: [`${PROVIDER_ID}/*`],
    hideThinkingBlock: false,
    startup: { setupWizard: false, showSplash: false, quiet: true },
    mcp: { startupTimeoutMs: 0 },
    ...(compaction.local ? { compaction: localCompaction(ctx, compaction.percent) } : {}),
    disabledProviders: [
      "claude", "codex", "cursor", "gemini", "opencode", "windsurf", "cline", "vscode", "claude-plugins", "agent-plugins",
    ],
  };

  const mcp = {
    mcpServers: Object.fromEntries(
      mcps.map((m) => [m.id, { command: m.command, args: m.args, ...(m.env ? { env: m.env } : {}) }]),
    ),
  };

  // OMP accepts JSON in .yml files (JSON is valid YAML).
  writeFileSync(join(paths.omp, "models.yml"), JSON.stringify(models, null, 2));
  writeFileSync(OMP_CONFIG, JSON.stringify(config, null, 2));
  writeFileSync(join(paths.omp, "mcp.json"), JSON.stringify(mcp, null, 2));
}
