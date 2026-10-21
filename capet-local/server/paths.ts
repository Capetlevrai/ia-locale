import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
/** Executable suffix of the llama.cpp and Bun binaries. */
export const EXE = IS_WINDOWS ? ".exe" : "";

/** Where each system keeps per-user application data. */
function appDataDir(): string {
  if (IS_WINDOWS) return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (IS_MAC) return join(homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

const defaultBase = join(appDataDir(), "CapetLocal");

/**
 * Engine and models can live on another drive (models weigh 10-15 GB each).
 * install.ps1 -DataDir (install.sh --data-dir) writes the chosen folder to CapetLocal/home.txt: a file
 * works whatever environment Paseo was started with, unlike a variable.
 */
function resolveBase(): string {
  if (process.env.CAPET_LOCAL_HOME) return process.env.CAPET_LOCAL_HOME;
  const pointer = join(defaultBase, "home.txt");
  if (existsSync(pointer)) {
    const target = readFileSync(pointer, "utf8").replace(/^﻿/, "").trim();
    if (target) return target;
  }
  return defaultBase;
}

const base = resolveBase();

export const paths = {
  base,
  runtime: join(base, "runtime"),
  models: join(base, "models"),
  omp: join(base, "omp"),
  logs: join(base, "logs"),
  state: join(base, "state.json"),
  /** VRAM --fit left unused per GPU + model, given back on the next start. */
  calibration: join(base, "calibration.json"),
};

for (const dir of [paths.runtime, paths.models, paths.omp, paths.logs]) {
  mkdirSync(dir, { recursive: true });
}

export const GATEWAY_PORT = 8190;
export const ENGINE_PORT = 8191;
export const PROVIDER_ID = "capet-local";
