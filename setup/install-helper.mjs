// Steps of install.sh (macOS, Linux) that edit JSON or talk to the plugin, run by Bun.
// Usage: bun install-helper.mjs <command> [args...]
//   enable-plugins <paseo-config.json>
//   wait-gateway <seconds>
//   model <paseo-cli> <paseo-config.json> <plugin-settings.json>   (engine, model, agent)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const GATEWAY = "http://127.0.0.1:8190";
const PLUGIN_ID = "capet-local";

const color = (code) => (t) => (process.stdout.isTTY ? `\x1b[${code}m${t}\x1b[0m` : t);
const green = color(32);
const yellow = color(33);
const red = color(31);
const ok = (t) => console.log(`  ${green("OK")}  ${t}`);
const warn = (t) => console.log(`  ${yellow("!")}   ${t}`);
const fail = (t) => {
  console.log(`  ${red("X")}   ${t}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1).replace(".", ",");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

async function api(method, path, body, timeoutMs = 60_000) {
  const res = await fetch(`${GATEWAY}/capet/${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function status() {
  try {
    return await api("GET", "status", undefined, 15_000);
  } catch {
    return null;
  }
}

async function waitGateway(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const s = await status();
    if (s) return s;
    await sleep(3000);
  }
  return null;
}

function paseo(cli, ...args) {
  const run = Bun.spawnSync([cli, ...args], { stdout: "pipe", stderr: "pipe" });
  return `${run.stdout.toString()}${run.stderr.toString()}`;
}

/** Third-party plugins only load with "pluginsEnabled": true (no CLI flag for it). */
function enablePlugins(config) {
  const json = readJson(config);
  if (json.pluginsEnabled === true) return;
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  copyFileSync(config, `${config}.capet-install-${stamp}.bak`);
  json.pluginsEnabled = true;
  writeJson(config, json);
  ok("Plugins tiers activés dans Paseo");
}

async function modelStep(cli, config, settingsFile) {
  let s = await status();
  if (!s) fail("Le plugin ne répond pas. Relance l'installation.");
  if (!s.runtime.installed) {
    console.log("  Téléchargement du moteur llama.cpp...");
    try {
      await api("POST", "install-runtime", {}, 1_800_000);
    } catch (error) {
      fail(`Moteur non installé : ${error.message}`);
    }
    s = await status();
  }
  if (!s?.runtime.installed) fail("Le moteur llama.cpp ne s'est pas installé. Relance l'installation.");
  ok("Moteur llama.cpp installé");

  let chosen = null;
  if (existsSync(settingsFile)) {
    try {
      chosen = readJson(settingsFile).values?.modelId ?? null;
    } catch {}
  }
  const model = s.models.find((m) => m.id === chosen) ?? s.models.find((m) => m.tier === "recommended");
  if (!model) {
    warn("Aucun modèle conseillé pour cette machine : choisis-en un dans Paseo > IA locale.");
    return;
  }
  ok(`Modèle conseillé : ${model.label} (${gb(model.sizeBytes)} Go)`);
  if (model.id !== chosen) {
    writeJson(settingsFile, { version: 1, values: { modelId: model.id } });
    paseo(cli, "plugin", "reload", PLUGIN_ID);
    if (!(await waitGateway(120))) fail("Le plugin ne répond plus après le choix du modèle.");
  }

  // Live progress; the plugin resumes on network cuts, restart it if it gives up.
  let tries = 0;
  for (;;) {
    const m = (await status())?.models.find((x) => x.id === model.id);
    if (m?.installed) break;
    if (!m?.download || m.download.state !== "running") {
      if (tries >= 5) {
        process.stdout.write("\n");
        fail(`Téléchargement du modèle impossible : ${m?.download?.error ?? "erreur inconnue"}`);
      }
      tries++;
      await api("POST", "download-model", { modelId: model.id }).catch(() => {});
      await sleep(3000);
      continue;
    }
    const d = m.download;
    const pct = d.total > 0 ? Math.floor((100 * d.done) / d.total) : 0;
    process.stdout.write(`\r  Téléchargement du modèle : ${gb(d.done)} / ${gb(d.total)} Go (${pct} %)   `);
    await sleep(3000);
  }
  process.stdout.write("\n");
  ok("Modèle téléchargé");

  console.log("  Chargement du modèle (une à deux minutes)...");
  let e;
  try {
    e = await api("POST", "apply", {}, 1_800_000);
  } catch (error) {
    fail(`Le modèle ne s'est pas chargé : ${error.message}`);
  }
  if (e.state !== "ready") fail(`Le modèle ne s'est pas chargé : ${e.error} (journal : logs/llama-server.log)`);
  ok(`Modèle chargé : ${Math.round(e.ctx / 1024)}K de contexte, ${e.vision ? "avec la vision" : "sans la vision"}`);
  if (e.notice) warn(e.notice);

  // The plugin only gets a Paseo client once the app opens: register the agent here.
  const entry = await api("GET", "provider", undefined, 30_000);
  const json = readJson(config);
  json.agents ??= {};
  json.agents.providers ??= {};
  json.agents.providers[entry.id] = entry.entry;
  writeJson(config, json);
  paseo(cli, "reload");
  const providers = paseo(cli, "provider", "ls");
  if (/IA locale|capet-local/.test(providers)) ok("Agent « IA locale » ajouté à Paseo");
  else warn("Agent « IA locale » ajouté ; il apparaîtra à l'ouverture de Paseo.");
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "enable-plugins":
    enablePlugins(args[0]);
    break;
  case "wait-gateway":
    process.exit((await waitGateway(Number(args[0] ?? 180))) ? 0 : 1);
    break;
  case "model":
    await modelStep(args[0], args[1], args[2]);
    break;
  default:
    fail(`Commande inconnue : ${command}`);
}
