import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Progress } from "../shared/rpc";

export interface DownloadFile {
  url: string;
  dest: string;
  size?: number;
  /** Expected SHA-256 (hex). Checked once the file is complete. */
  sha256?: string;
}

interface Job {
  progress: Progress;
  abort: AbortController;
  promise: Promise<void>;
  dests: string[];
}

const jobs = new Map<string, Job>();

export function jobProgress(key: string): Progress | null {
  return jobs.get(key)?.progress ?? null;
}

export function cancelJob(key: string): void {
  jobs.get(key)?.abort.abort();
}

export function isRunning(key: string): boolean {
  return jobs.get(key)?.progress.state === "running";
}

/** Kept free on the disk after a download: the system and the engine need room to breathe. */
const DISK_MARGIN = 2 * 1024 ** 3;

/** Refuse a download the disk cannot hold, rather than fail 15 GB later. */
function checkDiskSpace(files: DownloadFile[]): void {
  const first = files[0];
  if (!first) return;
  let needed = 0;
  for (const file of files) {
    const part = `${file.dest}.part`;
    needed += Math.max(0, (file.size ?? 0) - (existsSync(part) ? statSync(part).size : 0));
  }
  let free: number;
  try {
    const fs = statfsSync(dirname(first.dest));
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return; // Unknown: let the download try.
  }
  if (needed + DISK_MARGIN > free) {
    const go = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace(".", ",");
    throw new Error(
      `Pas assez de place sur le disque : il faut ${go(needed + DISK_MARGIN)} Go libres, il en reste ${go(free)} dans ${dirname(first.dest)}.`,
    );
  }
}

/**
 * Download a list of files as one job, resuming any `.part` left by an
 * interrupted run. The job stays queryable after it finishes so the UI can
 * show the error.
 */
export function startJob(key: string, label: string, files: DownloadFile[], after?: () => Promise<void>): Promise<void> {
  const existing = jobs.get(key);
  if (existing?.progress.state === "running") return existing.promise;
  // Catalog entries can share files (Qwen3.6 10 Go and 12-16 Go): two jobs must not
  // write the same .part, so follow the one already downloading it.
  const sharing = [...jobs.values()].find(
    (job) => job.progress.state === "running" && files.some((f) => job.dests.includes(f.dest)),
  );
  if (sharing) {
    jobs.set(key, sharing);
    return sharing.promise;
  }

  const todo = files.filter((f) => !existsSync(f.dest));
  const total = todo.reduce((sum, f) => sum + (f.size ?? 0), 0);
  const progress: Progress = { label, done: 0, total, state: "running" };
  const abort = new AbortController();

  const promise = (async () => {
    try {
      checkDiskSpace(todo);
      let finished = 0;
      for (const file of todo) {
        await downloadWithRetry(file, abort.signal, (bytes, fileTotal) => {
          if (!file.size && fileTotal) progress.total = Math.max(progress.total, finished + fileTotal);
          progress.done = finished + bytes;
        });
        finished += file.size ?? statSync(file.dest).size;
        progress.done = finished;
      }
      if (after) await after();
      progress.state = "done";
    } catch (error) {
      progress.state = "error";
      progress.error = abort.signal.aborted ? "Annulé" : error instanceof Error ? error.message : String(error);
    }
  })();

  jobs.set(key, { progress, abort, promise, dests: todo.map((f) => f.dest) });
  return promise;
}

/** An HTTP answer, or a damaged file, that retrying the same request will not change. */
class PermanentError extends Error {}

/** Connection cuts are common on 10+ GB files: resume the .part on our own before giving up. */
const RETRIES = 8;

async function downloadWithRetry(
  file: DownloadFile,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number | null) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadFile(file, signal, onProgress);
    } catch (error) {
      if (signal.aborted || error instanceof PermanentError || attempt >= RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5_000 * attempt)));
      if (signal.aborted) throw error;
    }
  }
}

async function sha256Of(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path, { highWaterMark: 4 * 1024 * 1024 }), hash, { signal });
  return hash.digest("hex");
}

/**
 * The .part is complete: check it is the file the catalog expects, then give it its
 * final name. A damaged file is deleted, so the next try starts clean instead of
 * handing llama.cpp a model that crashes on load.
 */
async function finish(file: DownloadFile, signal: AbortSignal): Promise<void> {
  const part = `${file.dest}.part`;
  const damaged = (why: string) => {
    unlinkSync(part);
    return new PermanentError(`Fichier téléchargé abîmé (${why}) : relance le téléchargement.`);
  };
  if (file.size && statSync(part).size !== file.size) throw damaged("taille inattendue");
  if (file.sha256 && (await sha256Of(part, signal)) !== file.sha256) throw damaged("empreinte SHA-256 différente");
  renameSync(part, file.dest);
}

async function downloadFile(
  file: DownloadFile,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number | null) => void,
): Promise<void> {
  const { url, dest } = file;
  const part = `${dest}.part`;
  let offset = existsSync(part) ? statSync(part).size : 0;

  const response = await fetch(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    redirect: "follow",
    signal,
  });
  if (response.status === 416) {
    // Nothing left to send: the .part already holds the whole file (finish() checks it).
    return finish(file, signal);
  }
  if (!response.ok || !response.body) {
    const transient = response.status >= 500 || response.status === 408 || response.status === 429;
    const message = `Téléchargement impossible (${response.status}) : ${url}`;
    throw transient ? new Error(message) : new PermanentError(message);
  }
  if (response.status === 200 && offset > 0) {
    // Server ignored the Range header: start over.
    unlinkSync(part);
    offset = 0;
  }

  const length = Number(response.headers.get("content-length") ?? 0);
  const total = length > 0 ? offset + length : null;
  let bytes = offset;
  onProgress(bytes, total);

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      onProgress(bytes, total);
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream),
    counter,
    createWriteStream(part, { flags: offset > 0 ? "a" : "w" }),
    { signal },
  );

  if (total !== null && statSync(part).size !== total) {
    throw new Error("Téléchargement incomplet, relance pour reprendre.");
  }
  await finish(file, signal);
}

export function hfUrl(file: { repo: string; file: string; revision: string }): string {
  // Files can sit in a subfolder of the repo (RCO/…): keep the slashes.
  const path = file.file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${path}`;
}
