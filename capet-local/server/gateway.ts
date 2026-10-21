import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ENGINE_PORT, GATEWAY_PORT } from "./paths";
import { callStarted, callTimings, type LlamaTimings } from "./stats";

/**
 * Stable endpoint for agents. Starts the engine on the first request (so VRAM
 * stays free until an agent actually talks), rewrites requests the Qwen chat
 * template rejects, and records activity for idle unloading.
 */
export interface GatewayHooks {
  /** Make sure the engine is ready; returns the model id it serves. */
  ensureEngine(): Promise<string>;
  onActivity(): void;
  /** Reasoning token cap for a request's effort level, or null for no cap. */
  reasoningBudget(effort: string | null): Promise<number | null>;
  /** Whether the running engine loaded its vision projector. */
  vision(): boolean;
  /** Sampling for the loaded model, or null before it loads. */
  sampling(): Record<string, number> | null;
  /** Local control API under /capet/ for scripted tests (127.0.0.1 only). */
  admin(method: string, path: string, body: unknown): Promise<unknown>;
}

/** Without the charset, Windows PowerShell (install.ps1) reads French text as Latin-1. */
const JSON_TYPE = "application/json; charset=utf-8";

let server: Server | null = null;

export function startGateway(hooks: GatewayHooks): Promise<void> {
  if (server) return Promise.resolve();
  const srv = createServer((req, res) => {
    handle(req, res, hooks).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) res.writeHead(503, { "content-type": JSON_TYPE });
      res.end(JSON.stringify({ error: { message: `IA locale indisponible : ${message}` } }));
    });
  });
  server = srv;
  return new Promise((resolve, reject) => {
    srv.once("error", (error) => {
      server = null;
      reject(error);
    });
    srv.listen(GATEWAY_PORT, "127.0.0.1", () => resolve());
  });
}

export function stopGateway(): void {
  server?.close();
  server = null;
}

async function handle(req: IncomingMessage, res: ServerResponse, hooks: GatewayHooks): Promise<void> {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": JSON_TYPE });
    res.end('{"status":"ok"}');
    return;
  }

  const body = await readBody(req);

  if (req.url?.startsWith("/capet/")) {
    try {
      const input = body.length > 0 ? JSON.parse(body.toString("utf8")) : {};
      const result = await hooks.admin(req.method ?? "GET", req.url.slice("/capet/".length), input);
      res.writeHead(200, { "content-type": JSON_TYPE });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "content-type": JSON_TYPE });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  hooks.onActivity();
  const modelId = await hooks.ensureEngine();

  let payload = body;
  let isCompletion = false;
  if (body.length > 0 && req.headers["content-type"]?.includes("json")) {
    try {
      const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      rewrite(json, modelId);
      if (!hooks.vision()) dropImages(json);
      // An agent keeps the sampling of the model it was opened with (OMP sends it on every
      // request): after a model switch, Qwen3.6 would run at Swift's temperature 1.0.
      if (Array.isArray(json.messages)) Object.assign(json, hooks.sampling());
      if (Array.isArray(json.messages)) await capReasoning(json, hooks);
      isCompletion = Array.isArray(json.messages);
      // Running timings on every streamed chunk: feeds the live tok/s counter.
      if (isCompletion && json.stream === true) json.timings_per_token = true;
      payload = Buffer.from(JSON.stringify(json));
    } catch {
      // Not JSON after all: forward untouched.
    }
  }
  if (isCompletion) callStarted();

  const headers = { ...req.headers, host: `127.0.0.1:${ENGINE_PORT}`, "content-length": String(payload.length) };
  const upstream = httpRequest(
    { host: "127.0.0.1", port: ENGINE_PORT, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const sniff = isCompletion ? timingsSniffer() : null;
      upstreamRes.on("data", (chunk: Buffer) => {
        hooks.onActivity();
        sniff?.push(chunk);
      });
      upstreamRes.on("end", () => sniff?.end());
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": JSON_TYPE });
    res.end(JSON.stringify({ error: { message: error.message } }));
  });
  req.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.end(payload);
}

/**
 * Pull llama-server `timings` out of a response without altering it: SSE
 * chunks for streams (one data line per chunk), the whole JSON otherwise.
 */
function timingsSniffer() {
  let pending = "";
  let streamed = false;
  const take = (text: string) => {
    const at = text.indexOf('"timings"');
    if (at < 0) return;
    try {
      const timings = (JSON.parse(text) as { timings?: LlamaTimings }).timings;
      if (timings) callTimings(timings);
    } catch {
      // Partial or non-JSON line.
    }
  };
  return {
    push(chunk: Buffer) {
      pending += chunk.toString("utf8");
      if (!streamed && !pending.startsWith("data:")) {
        // Plain JSON response: wait for the end, but don't hoard a huge body.
        if (pending.length > 8_000_000) pending = "";
        return;
      }
      streamed = true;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("data:")) take(line.slice(5).trim());
    },
    end() {
      if (!streamed) take(pending);
      else if (pending.startsWith("data:")) take(pending.slice(5).trim());
      pending = "";
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type Message = { role?: string; content?: unknown };

/** Reasoning budget is enforced by llama.cpp per request; the message lets the model close its thinking cleanly. */
async function capReasoning(json: Record<string, unknown>, hooks: GatewayHooks): Promise<void> {
  const kwargs = json.chat_template_kwargs as { reasoning_effort?: unknown } | undefined;
  const effort = kwargs?.reasoning_effort ?? json.reasoning_effort;
  const budget = await hooks.reasoningBudget(typeof effort === "string" ? effort : null);
  if (budget === null) return;
  json.reasoning_budget_tokens = budget;
  json.reasoning_budget_message =
    "Time is up for thinking. Stop planning and act now: answer or call the next tool with what you have.";
}

function rewrite(json: Record<string, unknown>, modelId: string): void {
  // One model is loaded at a time: whatever name the agent sends, serve it.
  if (typeof json.model === "string") json.model = modelId;

  const messages = json.messages;
  if (!Array.isArray(messages)) return;
  // Qwen templates reject system/developer messages after the first turn.
  // Fold them into the next user message as a reminder.
  const out: Message[] = [];
  let pending: string[] = [];
  messages.forEach((raw: Message, index: number) => {
    const msg = { ...raw };
    if (msg.role === "developer") msg.role = "system";
    if (msg.role === "system" && index > 0) {
      pending.push(textOf(msg.content));
      return;
    }
    if (pending.length > 0 && msg.role === "user") {
      const reminder = pending.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n");
      msg.content = prependText(msg.content, reminder);
      pending = [];
    }
    out.push(msg);
  });
  if (pending.length > 0) {
    out.push({ role: "user", content: pending.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n") });
  }
  json.messages = out;
}

/** Sent in place of an image when the engine runs without its vision projector. */
const NO_VISION =
  "[Image non transmise : la vision de l'IA locale est désactivée dans ses réglages (onglet IA locale, " +
  "ou accélération DFlash, incompatible avec les images). Dis-le à l'utilisateur.]";

/**
 * Without --mmproj llama-server answers 500 to any image, and the agent stops. Vision can be
 * turned off after an agent started, which may then still send images: replace them with a
 * note the model can relay.
 */
function dropImages(json: Record<string, unknown>): void {
  if (!Array.isArray(json.messages)) return;
  for (const msg of json.messages as Message[]) {
    if (!Array.isArray(msg.content)) continue;
    let noted = false;
    msg.content = msg.content.flatMap((part: { type?: string }) => {
      if (part?.type !== "image_url" && part?.type !== "input_image") return [part];
      if (noted) return [];
      noted = true;
      return [{ type: "text", text: NO_VISION }];
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part?.type === "text" ? (part.text ?? "") : ""))
      .join("\n");
  }
  return "";
}

function prependText(content: unknown, text: string): unknown {
  if (typeof content === "string") return `${text}\n\n${content}`;
  if (Array.isArray(content)) return [{ type: "text", text }, ...content];
  return text;
}
