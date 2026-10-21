import { execCommand } from "@getpaseo/plugin/server";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME, type RuntimeVariant } from "./catalog";
import { jobProgress, startJob } from "./download";
import { EXE, IS_MAC, IS_WINDOWS, paths } from "./paths";

const JOB_KEY = "runtime";
const SERVER = `llama-server${EXE}`;
const WINDOWS_TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

function runtimeDir(variant: RuntimeVariant): string {
  return join(paths.runtime, `${RUNTIME.tag}-${variant}`);
}

export function runtimeLabel(variant: RuntimeVariant): string {
  return `llama.cpp ${RUNTIME.tag} (${variant.toUpperCase()})`;
}

/** Path to llama-server for this GPU, or null when not installed. */
export function findServerExe(variant: RuntimeVariant): string | null {
  const exe = join(runtimeDir(variant), SERVER);
  return existsSync(exe) ? exe : null;
}

export function runtimeDownload() {
  return jobProgress(JOB_KEY);
}

/** Asset sizes from the GitHub release, so progress covers both archives from the start. */
async function assetSizes(): Promise<Map<string, number>> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RUNTIME.repo}/releases/tags/${RUNTIME.tag}`);
    const release = (await res.json()) as { assets?: { name: string; size: number }[] };
    return new Map((release.assets ?? []).map((a) => [a.name, a.size]));
  } catch {
    return new Map();
  }
}

export async function installRuntime(variant: RuntimeVariant): Promise<void> {
  const dir = runtimeDir(variant);
  const staging = join(paths.runtime, "_download");
  mkdirSync(staging, { recursive: true });
  const sizes = await assetSizes();
  const files = RUNTIME.assets(variant).map((name) => ({
    url: `https://github.com/${RUNTIME.repo}/releases/download/${RUNTIME.tag}/${name}`,
    dest: join(staging, name),
    size: sizes.get(name),
  }));

  return startJob(JOB_KEY, "Moteur llama.cpp", files, async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      // Windows ships bsdtar, which reads the flat zip archives. The Linux and macOS
      // archives keep everything in one top folder (llama-b11669/): drop it.
      // Full path: with Git's Unix tools first in PATH, "tar.exe" is GNU tar, which reads
      // "C:\..." as a remote host ("Cannot connect to C: resolve failed").
      if (IS_WINDOWS) await execCommand(WINDOWS_TAR, ["-xf", file.dest, "-C", dir], { timeout: 300_000 });
      else await execCommand("tar", ["-xzf", file.dest, "-C", dir, "--strip-components=1"], { timeout: 300_000 });
    }
    if (!existsSync(join(dir, SERVER))) {
      const nested = readdirSync(dir).find((entry) => existsSync(join(dir, entry, SERVER)));
      if (!nested) throw new Error(`${SERVER} introuvable dans l'archive`);
      throw new Error(`Archive inattendue : moteur dans ${nested}`);
    }
    // A quarantine mark (copied by hand from a browser download) blocks unsigned binaries.
    if (IS_MAC) await execCommand("xattr", ["-dr", "com.apple.quarantine", dir], { timeout: 30_000 }).catch(() => {});
    rmSync(staging, { recursive: true, force: true });
  });
}
