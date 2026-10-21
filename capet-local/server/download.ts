import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Progress } from "../shared/rpc";

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

/**
 * Download a list of files as one job, resuming any `.part` left by an
 * interrupted run. The job stays queryable after it finishes so the UI can
 * show the error.
 */
export function startJob(
  key: string,
  label: string,
  files: { url: string; dest: string; size?: number }[],
  after?: () => Promise<void>,
): Promise<void> {
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
      let finished = 0;
      for (const file of todo) {
        await downloadWithRetry(file.url, file.dest, abort.signal, (bytes, fileTotal) => {
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

/** An HTTP answer that retrying won't change (404, 401...). */
class PermanentError extends Error {}

/** Connection cuts are common on 10+ GB files: resume the .part on our own before giving up. */
const RETRIES = 8;

async function downloadWithRetry(
  url: string,
  dest: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number | null) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadFile(url, dest, signal, onProgress);
    } catch (error) {
      if (signal.aborted || error instanceof PermanentError || attempt >= RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5_000 * attempt)));
      if (signal.aborted) throw error;
    }
  }
}

async function downloadFile(
  url: string,
  dest: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number | null) => void,
): Promise<void> {
  const part = `${dest}.part`;
  let offset = existsSync(part) ? statSync(part).size : 0;

  const response = await fetch(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    redirect: "follow",
    signal,
  });
  if (response.status === 416) {
    // The .part already holds the whole file.
    renameSync(part, dest);
    return;
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
  renameSync(part, dest);
}

export function hfUrl(file: { repo: string; file: string; revision: string }): string {
  // Files can sit in a subfolder of the repo (RCO/…): keep the slashes.
  const path = file.file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${path}`;
}
