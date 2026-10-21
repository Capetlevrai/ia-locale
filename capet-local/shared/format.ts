import type { AgentStats, TurnStats } from "./rpc";

const nf = new Intl.NumberFormat("fr-FR");

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace(".", ",")} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")}`;
}

export const tokS = (v: number | null) => (v === null ? "—" : `${Math.round(v)} tok/s`);
export const count = (n: number) => nf.format(n);

/** Short duration for the pill, which truncates long labels: "14s", "2m32". */
function short(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}`;
}

const shortTokS = (v: number | null) => (v === null ? "—" : `${Math.round(v)} t/s`);

/** One-line summary for the composer pill. */
export function pillLabel(t: TurnStats): string {
  switch (t.outcome) {
    case "running":
      return t.liveTokS !== null ? `⚡ ${shortTokS(t.liveTokS)} · ${short(t.elapsedMs)}` : `⏳ ${short(t.elapsedMs)}`;
    case "completed":
      return `✓ ${short(t.elapsedMs)} · ${shortTokS(t.genTokS)}`;
    case "failed":
      return `✗ ${short(t.elapsedMs)}`;
    case "canceled":
      return `■ ${short(t.elapsedMs)}`;
  }
}

/** Detail rows, label -> value, shared by the popover and the IA locale screen. */
export function detailRows(t: TurnStats): [string, string][] {
  const rows: [string, string][] = [
    [t.outcome === "running" ? "Temps écoulé" : "Temps total (envoi → réponse)", duration(t.elapsedMs)],
    ["Avant le premier mot", t.firstTokenMs === null ? "—" : duration(t.firstTokenMs)],
    ["Vitesse d'écriture", tokS(t.outcome === "running" && t.liveTokS !== null ? t.liveTokS : t.genTokS)],
    ["Tokens écrits (réflexion comprise)", count(t.genTokens)],
    [
      "Contexte lu",
      `${count(t.promptTokens)} tokens` + (t.promptTokS !== null && t.promptTokens > 0 ? ` à ${tokS(t.promptTokS)}` : ""),
    ],
    ["Appels au modèle", count(t.calls)],
  ];
  if (t.cachedTokens > 0) rows.splice(5, 0, ["Contexte réutilisé (cache)", `${count(t.cachedTokens)} tokens`]);
  if (t.draftAcceptance !== null) rows.push(["Prédictions MTP/DFlash acceptées", `${Math.round(t.draftAcceptance * 100)} %`]);
  return rows;
}

/** Running turn if any, else the most recent finished one. */
export function latestTurn(agents: AgentStats[]): TurnStats | null {
  const turns = agents.flatMap((a) => [a.current, a.last]).filter((t): t is TurnStats => t !== null);
  const running = turns.filter((t) => t.outcome === "running");
  const pool = running.length > 0 ? running : turns;
  return pool.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}
