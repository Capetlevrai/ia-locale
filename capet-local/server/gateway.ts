import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ENGINE_PORT, GATEWAY_PORT } from "./paths";
import { callStarted, callTimings, type CallHandle, type LlamaTimings } from "./stats";

/**
 * Stable endpoint for agents. Starts the engine on the first request (so VRAM
 * stays free until an agent actually talks), rewrites requests the Qwen chat
 * template rejects, and records activity for idle unloading.
 */
export interface GatewayHooks {
  /**
   * Make sure the engine is ready, on `requested` when that is a downloaded model, and
   * return the model id it serves. `idle` tells when no call is in flight: a model swap
   * waits for it.
   */
  ensureEngine(requested: string | null, idle: () => boolean, gone: () => boolean): Promise<string>;
  /** Model the engine serves right now, or null while it is stopped or loading. */
  loadedModel(): string | null;
  onActivity(): void;
  /** Reasoning token cap for a request's effort level, or null for no cap. */
  reasoningBudget(effort: string | null): Promise<number | null>;
  /** Whether the running engine loaded its vision projector. */
  vision(): boolean;
  /** Sampling for the loaded model, or null before it loads. */
  sampling(): Record<string, number> | null;
  /** Key the engine demands on its own port, so nothing but the gateway can use it. */
  engineKey(): string;
  /** Local control API under /capet/ for scripted tests (127.0.0.1 only). */
  admin(method: string, path: string, body: unknown): Promise<unknown>;
}

/** Without the charset, Windows PowerShell (install.ps1) reads French text as Latin-1. */
const JSON_TYPE = "application/json; charset=utf-8";

let server: Server | null = null;
/** Requests being served by the engine. */
let inFlight = 0;

/** Why the gateway is not listening (port taken by another program), or null. */
let listenError: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/** Calls waiting for the engine, in arrival order (see handle()). */
let queue: Promise<void> = Promise.resolve();

/** The last calls agents made: what they asked for and what served them. Helps support. */
const recent: string[] = [];
function note(req: IncomingMessage, requested: string | null, served: string): void {
  recent.push(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} demandé=${requested ?? "-"} servi=${served}`);
  if (recent.length > 40) recent.shift();
}
export function recentCalls(): string[] {
  return recent;
}

/** Calls the engine is serving right now (a model swap waits for 0). */
export function callsInFlight(): number {
  return inFlight;
}

export function gatewayError(): string | null {
  return listenError;
}

/** Listen, and keep trying every 10 s while the port is taken: the UI shows why meanwhile. */
export function startGateway(hooks: GatewayHooks): void {
  stopped = false;
  listen(hooks).then(
    () => (listenError = null),
    (error: NodeJS.ErrnoException) => {
      listenError =
        error.code === "EADDRINUSE"
          ? `Le port ${GATEWAY_PORT} est déjà utilisé par un autre programme : l'agent IA locale ne peut pas démarrer. Ferme ce programme (ou redémarre le PC) ; l'IA locale réessaie toute seule.`
          : `La passerelle de l'IA locale n'a pas démarré : ${error.message}`;
      console.error(`[capet-local] gateway on :${GATEWAY_PORT} failed`, error);
      if (!stopped) retry = setTimeout(() => startGateway(hooks), 10_000);
    },
  );
}

function listen(hooks: GatewayHooks): Promise<void> {
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
  stopped = true;
  if (retry) clearTimeout(retry);
  server?.close();
  // Keep-alive connections from agents would hold the port through a plugin reload.
  server?.closeAllConnections();
  server = null;
}

/**
 * Only local programs (the agent, the installer) may talk to the gateway. A web page open
 * in the user's browser can reach 127.0.0.1 too: without this check any site could stop
 * the engine, start a 19 GB download or use the model. Browsers mark such requests with
 * Origin or Sec-Fetch-Site, and a DNS-rebinding page arrives with its own Host.
 */
function fromBrowser(req: IncomingMessage): boolean {
  if (req.headers.origin) return true;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "none" && site !== "same-origin") return true;
  const host = (req.headers.host ?? "").toLowerCase();
  return host !== `127.0.0.1:${GATEWAY_PORT}` && host !== `localhost:${GATEWAY_PORT}`;
}

async function handle(req: IncomingMessage, res: ServerResponse, hooks: GatewayHooks): Promise<void> {
  if (fromBrowser(req)) {
    req.resume();
    res.writeHead(403, { "content-type": JSON_TYPE });
    res.end(JSON.stringify({ error: { message: "IA locale : accès réservé aux programmes de cet ordinateur." } }));
    return;
  }
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
  let json: Record<string, unknown> | null = null;
  if (body.length > 0 && req.headers["content-type"]?.includes("json")) {
    try {
      json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      // Not JSON after all: forward untouched.
    }
  }
  // The model the agent's picker is on. The engine holds one model: when the agent asks for
  // another downloaded one, it is loaded in its place, once the calls in flight are done
  // (they would be cut otherwise). Then hold the engine for this call.
  const requested = json && Array.isArray(json.messages) && typeof json.model === "string" ? json.model : null;
  // The agent can give up while its call waits for a model to load (interrupted, model
  // changed again): listen from now on. A call counted after its connection closed would
  // never be released, and every later model swap would wait for it forever.
  let gone = false;
  let held = false;
  res.on("close", () => {
    gone = true;
    if (held) {
      held = false;
      inFlight -= 1;
    }
  });
  // One call at a time decides what the engine holds. Two calls asking for two different
  // models at once (two agents, or an agent and one of its helpers) would otherwise each
  // cancel the other's load, forever: first come, first served, the next one swaps after.
  const turn = queue;
  let done!: () => void;
  queue = new Promise<void>((resolve) => (done = resolve));
  let modelId: string;
  try {
    await turn;
    for (;;) {
      modelId = await hooks.ensureEngine(requested, () => inFlight === 0, () => gone);
      if (gone) {
        note(req, requested, "abandonné");
        return;
      }
      if (hooks.loadedModel() === modelId) break;
    }
    inFlight += 1;
    held = true;
  } finally {
    done();
  }
  note(req, requested, modelId);
  const release = () => {
    if (held) {
      held = false;
      inFlight -= 1;
    }
  };

  let payload = body;
  let isCompletion = false;
  if (json) {
    try {
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
    } catch (error) {
      release();
      throw error;
    }
  }
  const call = isCompletion ? callStarted(conversationKey(payload)) : null;

  const headers = {
    ...req.headers,
    host: `127.0.0.1:${ENGINE_PORT}`,
    "content-length": String(payload.length),
    authorization: `Bearer ${hooks.engineKey()}`,
  };
  const upstream = httpRequest(
    { host: "127.0.0.1", port: ENGINE_PORT, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const sniff = call ? timingsSniffer(call) : null;
      upstreamRes.on("data", (chunk: Buffer) => {
        hooks.onActivity();
        sniff?.push(chunk);
      });
      upstreamRes.on("end", () => sniff?.end());
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    release();
    if (!res.headersSent) res.writeHead(502, { "content-type": JSON_TYPE });
    res.end(JSON.stringify({ error: { message: error.message } }));
  });
  // The agent was interrupted: stop the engine's generation too. On the response, not the
  // request: a request's "close" fires once its body is read, long before this point.
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.end(payload);
}

/**
 * Identifies a conversation across its model calls: the system prompt and first user
 * message stay the same from one call to the next. Tells two agents' calls apart.
 */
function conversationKey(payload: Buffer): string | null {
  try {
    const { messages } = JSON.parse(payload.toString("utf8")) as { messages?: unknown[] };
    if (!Array.isArray(messages) || messages.length === 0) return null;
    return createHash("sha1").update(JSON.stringify(messages.slice(0, 2))).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Pull llama-server `timings` out of a response without altering it: SSE
 * chunks for streams (one data line per chunk), the whole JSON otherwise.
 */
function timingsSniffer(call: CallHandle) {
  let pending = "";
  let streamed = false;
  const take = (text: string) => {
    const at = text.indexOf('"timings"');
    if (at < 0) return;
    try {
      const timings = (JSON.parse(text) as { timings?: LlamaTimings }).timings;
      if (timings) callTimings(call, timings);
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
