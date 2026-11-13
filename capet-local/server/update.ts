import { VERSION } from "../shared/version";

/** Public repo that carries the installers of each version. */
const RELEASES = "Capetlevrai/ia-locale";
const CHECK_EVERY_MS = 12 * 60 * 60_000;

export interface Update {
  version: string;
  url: string;
}

let checkedAt = 0;
let found: Update | null = null;

/** "0.3.0-beta" -> [0, 3, 0]. */
function numbers(version: string): number[] {
  return version.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
}

function newer(a: string, b: string): boolean {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * A newer installer than this plugin, or null. Asks GitHub for the latest release at most
 * twice a day, in the background: the status never waits for the network, and nothing
 * about the PC is sent.
 */
export async function latestRelease(): Promise<Update | null> {
  if (Date.now() - checkedAt > CHECK_EVERY_MS) {
    checkedAt = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    void fetch(`https://api.github.com/repos/${RELEASES}/releases/latest`, { signal: abort.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ tag_name?: string; html_url?: string }>) : null))
      .then((release) => {
        const tag = release?.tag_name;
        found = tag && newer(tag, VERSION) ? { version: tag.replace(/^v/, ""), url: release?.html_url ?? `https://github.com/${RELEASES}/releases/latest` } : null;
      })
      .catch(() => {
        // Offline: ask again in a few minutes.
        checkedAt = Date.now() - CHECK_EVERY_MS + 10 * 60_000;
      })
      .finally(() => clearTimeout(timer));
  }
  return found;
}
