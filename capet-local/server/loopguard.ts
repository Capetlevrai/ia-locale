/**
 * A local model can lock into a loop: it runs a command, sees it fail, announces another
 * approach, then sends the very same command again, for as long as the agent lets it
 * (seen with Swift 1.5: the same download every 6 s for 7 minutes). The agent has no
 * guard for it. The gateway sees every call, so it counts how many times in a row the
 * model just sent the same tool calls: first it tells the model, then it ends the turn.
 */

type ToolCall = { function?: { name?: unknown; arguments?: unknown } };
type Message = { role?: string; content?: unknown; tool_calls?: unknown };

/** Identical calls in a row before the model is told it is repeating itself. */
export const NUDGE_AT = 3;
/** Identical calls in a row, each with the same result, before the turn is ended. */
export const STOP_AT = 6;
/** Identical calls in a row before the turn is ended whatever the results (a poll changes its output). */
export const STOP_ANYWAY_AT = 12;

/**
 * A stuck model often changes one number per try (page10.html, page11.html…): the calls
 * differ, the loop is the same. Numbers are masked before comparing, in calls and results.
 */
function masked(text: string): string {
  return text.replace(/[0-9]+/g, "#");
}

export interface Repeat {
  /** How many times in a row the model sent the same tool calls (numbers aside), up to the end of the conversation. */
  count: number;
  /** Whether those calls were identical to the last digit. */
  exact: boolean;
  /** Whether each of those runs returned the same result. */
  sameResults: boolean;
  /** The repeated call, shortened, to show the user. */
  label: string;
}

function signature(msg: Message): string | null {
  if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return null;
  return JSON.stringify(
    (msg.tool_calls as ToolCall[]).map((call) => [call?.function?.name ?? "", call?.function?.arguments ?? ""]),
  );
}

function label(msg: Message): string {
  const call = (msg.tool_calls as ToolCall[])[0];
  const name = typeof call?.function?.name === "string" ? call.function.name : "outil";
  let args = typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? "");
  args = args.replace(/\s+/g, " ");
  if (args.length > 160) args = `${args.slice(0, 160)}…`;
  return `${name} ${args}`;
}

/**
 * Looks at the end of a conversation: the last assistant turns with tool calls, each
 * followed by its tool results. Stops at the first turn that differs, or at anything the
 * user said (a new instruction starts a new count).
 */
export function trailingRepeat(messages: unknown[]): Repeat | null {
  let last: Message | null = null;
  let lastSignature: string | null = null;
  let lastExact: string | null = null;
  let exact = true;
  let count = 0;
  let sameResults = true;
  let results: string[] = [];
  let firstResults: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg?.role === "tool") {
      results.unshift(masked(JSON.stringify(msg.content ?? "")));
      continue;
    }
    const raw = signature(msg);
    if (raw === null) break;
    const sig = masked(raw);
    if (lastSignature === null) {
      // The conversation must end on the results of a call: the model is about to act again.
      if (results.length === 0) return null;
      lastSignature = sig;
      lastExact = raw;
      last = msg;
    } else if (sig !== lastSignature) break;
    if (raw !== lastExact) exact = false;
    const joined = results.join("\n");
    if (firstResults === null) firstResults = joined;
    else if (joined !== firstResults) sameResults = false;
    results = [];
    count += 1;
  }
  if (!last || count === 0) return null;
  return { count, exact, sameResults, label: label(last) };
}

export function shouldStop(repeat: Repeat): boolean {
  return (repeat.exact && repeat.count >= STOP_ANYWAY_AT) || (repeat.sameResults && repeat.count >= STOP_AT);
}

/** Calls that differ by a number and return different things are progress (reading a file by chunks), not a loop. */
export function shouldNudge(repeat: Repeat): boolean {
  return repeat.count >= NUDGE_AT && (repeat.exact || repeat.sameResults);
}

/** Added at the end of the conversation the model sees, never stored by the agent. */
export function nudge(repeat: Repeat): string {
  return (
    "<system-reminder>\n" +
    `You have now sent ${repeat.exact ? "the exact same tool call" : "the same tool call, changing only a number,"} ${repeat.count} times in a row` +
    (repeat.sameResults ? " and got the same result each time" : "") +
    ". Sending it again will not change anything. Do NOT send it again. " +
    "Either take a genuinely different action (other tool, other arguments, other source), " +
    "or stop calling tools and tell the user in plain words what blocks you and what you need from them.\n" +
    "</system-reminder>"
  );
}

/** What the user reads when the gateway ends the turn in the model's place. */
export function stopText(repeat: Repeat): string {
  return (
    `Je m'arrête : je viens de lancer ${repeat.count} fois de suite ${repeat.exact ? "exactement la même action" : "la même action, à un numéro près"}` +
    (repeat.sameResults ? ", avec le même résultat à chaque fois" : "") +
    `, et je tournais en rond.\n\nAction répétée : \`${repeat.label.replace(/`/g, "'")}\`\n\n` +
    "Dis-moi comment continuer : une autre piste, un fichier ou une adresse à utiliser, ou ce que tu veux que j'abandonne."
  );
}

/** A complete answer in the OpenAI chat format, streamed or not, that ends the agent's turn. */
export function stopResponse(text: string, model: string, stream: boolean, withUsage: boolean): { type: string; body: string } {
  const id = `chatcmpl-capet-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (!stream) {
    return {
      type: "application/json; charset=utf-8",
      body: JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage,
      }),
    };
  }
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`;
  let body = chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]);
  body += chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
  if (withUsage) body += chunk([], { usage });
  body += "data: [DONE]\n\n";
  return { type: "text/event-stream; charset=utf-8", body };
}
