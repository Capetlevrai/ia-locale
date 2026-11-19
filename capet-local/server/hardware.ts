import { execCommand } from "@getpaseo/plugin/server";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { GpuInfo, GpuVendor } from "../shared/rpc";
import { EXE, IS_MAC, IS_WINDOWS, paths } from "./paths";

/**
 * The card the engine runs on: NVIDIA first (CUDA engine, measured with nvidia-smi),
 * else the AMD, Intel or other card with the most VRAM (Vulkan engine). On a Mac, the
 * Apple chip's GPU (Metal engine).
 */
export async function detectGpu(): Promise<GpuInfo | null> {
  if (IS_MAC) return detectAppleGpu();
  return (await detectNvidiaGpu()) ?? (IS_WINDOWS ? await detectOtherGpu() : detectLinuxGpu());
}

/**
 * Multi-GPU machines: keep the card with the most VRAM. The engine is pinned to it
 * (engine.ts): left to itself llama.cpp splits the model across every card, which
 * --fit and the VRAM measures here don't account for (RTX 5080 + 3080: crash on the
 * first request, then a restart loop).
 */
function biggest(gpus: Omit<GpuInfo, "cards">[]): GpuInfo | null {
  gpus.sort((a, b) => b.vramTotalMiB - a.vramTotalMiB || a.index - b.index);
  const best = gpus[0];
  return best ? { ...best, cards: gpus.length } : null;
}

export async function detectNvidiaGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execCommand(
      "nvidia-smi",
      ["--query-gpu=index,name,memory.total,memory.used,memory.free,compute_cap", "--format=csv,noheader,nounits"],
      { timeout: 10_000 },
    );
    const gpus = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((f) => f.length >= 6)
      .map(([index, name, total, used, free, cap]) => ({
        vendor: "nvidia" as const,
        index: Number(index),
        name,
        vramTotalMiB: Number(total),
        vramUsedMiB: Number(used),
        vramFreeMiB: Number(free),
        computeCap: Number(cap),
        deviceId: 0,
      }));
    return biggest(gpus);
  } catch {
    return null;
  }
}

const VENDORS: Record<number, GpuVendor> = { 0x10de: "nvidia", 0x1002: "amd", 0x1022: "amd", 0x8086: "intel" };

/**
 * Any vendor, without its tools. DirectX keeps one registry key per adapter it has seen
 * (name, vendor, dedicated VRAM, LUID), and Windows' GPU counters give the dedicated memory
 * all programs use, per LUID. Only adapters present now have a counter; a LUID can come
 * back after a reboot, so the key seen last wins. Microsoft's software renderer is skipped.
 */
const OTHER_GPUS_PS = `
$used = @{}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {
  if ($_.Name -match '^luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_0$') { $used[[Convert]::ToInt64($matches[1] + $matches[2], 16)] = $_.DedicatedUsage }
}
Get-ChildItem HKLM:\\SOFTWARE\\Microsoft\\DirectX | ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.Description -and $_.VendorId -ne 0x1414 -and $used.ContainsKey([int64]$_.AdapterLuid) } |
  Sort-Object LastSeen -Descending | Group-Object AdapterLuid | ForEach-Object { $_.Group[0] } |
  ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.VendorId, $_.DedicatedVideoMemory, $used[[int64]$_.AdapterLuid], [int]$_.DeviceId, $_.Description }
`;

export async function detectOtherGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execCommand("powershell.exe", ["-NoProfile", "-Command", OTHER_GPUS_PS], { timeout: 20_000 });
    const MIB = 1024 * 1024;
    const gpus = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split("|"))
      .filter((f) => f.length >= 5 && Number(f[1]) > 0)
      .map(([vendorId, total, used, deviceId, ...name]) => {
        const totalMiB = Math.round(Number(total) / MIB);
        const usedMiB = Math.min(totalMiB, Math.round(Number(used) / MIB));
        return {
          vendor: VENDORS[Number(vendorId)] ?? ("other" as const),
          index: -1,
          name: name.join("|"),
          vramTotalMiB: totalMiB,
          vramUsedMiB: usedMiB,
          vramFreeMiB: totalMiB - usedMiB,
          computeCap: 0,
          deviceId: Number(deviceId) || 0,
        };
      });
    return biggest(gpus);
  } catch {
    return null;
  }
}

/**
 * Linux, AMD (and any driver that publishes its VRAM like amdgpu does): sysfs gives the
 * vendor and the VRAM every program uses. Cards whose driver doesn't (Intel) are skipped.
 */
export function detectLinuxGpu(): GpuInfo | null {
  const MIB = 1024 * 1024;
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  };
  let cards: string[];
  try {
    cards = readdirSync("/sys/class/drm").filter((entry) => /^card\d+$/.test(entry));
  } catch {
    return null;
  }
  const gpus = cards.flatMap((card) => {
    const device = join("/sys/class/drm", card, "device");
    const total = Number(read(join(device, "mem_info_vram_total")));
    if (!total) return [];
    const used = Number(read(join(device, "mem_info_vram_used"))) || 0;
    const vendor = VENDORS[Number(read(join(device, "vendor")))] ?? ("other" as const);
    const totalMiB = Math.round(total / MIB);
    const usedMiB = Math.min(totalMiB, Math.round(used / MIB));
    const label = vendor === "amd" ? "AMD Radeon" : vendor === "intel" ? "Intel Arc" : "Carte graphique";
    return [{
      vendor,
      index: -1,
      name: `${label} (${basename(card)})`,
      vramTotalMiB: totalMiB,
      vramUsedMiB: usedMiB,
      vramFreeMiB: totalMiB - usedMiB,
      computeCap: 0,
      deviceId: Number(read(join(device, "device"))) || 0,
    }];
  });
  return biggest(gpus);
}

/**
 * Apple Silicon: the GPU shares the RAM. macOS lets it wire about 2/3 of it (3/4 above
 * 36 GB), or what `iogpu.wired_limit_mb` sets; what other apps hold counts as used.
 */
export async function detectAppleGpu(): Promise<GpuInfo | null> {
  if (process.arch !== "arm64") return null;
  const sysctl = async (key: string) => {
    try {
      return (await execCommand("sysctl", ["-n", key], { timeout: 5_000 })).stdout.trim();
    } catch {
      return "";
    }
  };
  const ramMiB = Math.round(totalmem() / (1024 * 1024));
  const wired = Number(await sysctl("iogpu.wired_limit_mb"));
  const limitMiB = wired > 0 ? wired : Math.round(ramMiB * (ramMiB > 36 * 1024 ? 0.75 : 2 / 3));
  // Memory the system could hand over now: free, inactive, speculative and purgeable pages.
  let availableMiB = limitMiB;
  try {
    const { stdout } = await execCommand("vm_stat", [], { timeout: 5_000 });
    const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 16384);
    const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
    const free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
    availableMiB = Math.round((free * page) / (1024 * 1024));
  } catch {
    // Keep the whole limit.
  }
  const freeMiB = Math.max(0, Math.min(limitMiB, availableMiB));
  return {
    vendor: "apple",
    index: -1,
    cards: 1,
    name: (await sysctl("machdep.cpu.brand_string")) || "Apple Silicon",
    vramTotalMiB: limitMiB,
    vramUsedMiB: limitMiB - freeMiB,
    vramFreeMiB: freeMiB,
    computeCap: 0,
    deviceId: 0,
  };
}

/**
 * llama.cpp's name for a card in its Vulkan engine ("Vulkan1"), to pin it with --device.
 * Vulkan and DirectX name cards the same way, give or take (R)/(TM) marks.
 */
export async function vulkanCard(exe: string, gpuName: string): Promise<{ visible: string | null; device: string | null }> {
  const norm = (s: string) => s.toLowerCase().replace(/\((r|tm)\)/g, "").replace(/\s+/g, " ").trim();
  const list = async (env?: NodeJS.ProcessEnv) => {
    const { stdout, stderr } = await execCommand(exe, ["--list-devices"], { timeout: 30_000, env });
    const found: { device: string; name: string }[] = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const match = /^\s*(Vulkan\d+):\s*(.+?)\s*\(\d+ MiB/.exec(line);
      if (match) found.push({ device: match[1], name: match[2] });
    }
    return found;
  };
  try {
    const all = await list();
    const device = all.find((card) => norm(card.name) === norm(gpuName))?.device ?? null;
    // Unpinned: llama.cpp then uses every dedicated card.
    if (!device) return { visible: null, device: null };
    if (all.length === 1) return { visible: null, device };
    // The index counts every Vulkan device of the PC, in the driver's order: try each.
    for (let index = 0; index < 8; index++) {
      try {
        const only = await list({ ...process.env, GGML_VK_VISIBLE_DEVICES: String(index) });
        if (only.length === 1 && norm(only[0].name) === norm(gpuName)) return { visible: String(index), device };
      } catch {
        // Past the last device.
      }
    }
    return { visible: null, device };
  } catch {
    return { visible: null, device: null };
  }
}

export interface RocmCard {
  /** --device name once the card is alone. */
  device: string;
  /** HIP_VISIBLE_DEVICES index that hides every other AMD chip, or null when the card is alone anyway. */
  visible: string | null;
}

const rocmCards = new Map<string, RocmCard | null>();

/**
 * How the ROCm engine reaches this card, or null when it can't: it does not see it (the
 * engine would then run on the CPU without a word), or it sees several chips and the card
 * can't be isolated. With an integrated AMD chip next to the card, --device alone is not
 * enough (llama.cpp #23152): the chip is hidden with HIP_VISIBLE_DEVICES, whose index is
 * found by trying. Asked once per engine: the answer only changes with the driver.
 */
export async function rocmCard(exe: string, gpuName: string): Promise<RocmCard | null> {
  if (existsSync(paths.rocmTest)) return { device: "none", visible: null };
  const key = `${exe}|${gpuName}`;
  const known = rocmCards.get(key);
  if (known !== undefined) return known;
  const norm = (s: string) => s.toLowerCase().replace(/\((r|tm)\)/g, "").replace(/\s+/g, " ").trim();
  const mine = (name: string) => norm(name) === norm(gpuName) || norm(name).includes(norm(gpuName)) || norm(gpuName).includes(norm(name));
  const list = async (env?: NodeJS.ProcessEnv) => {
    const { stdout, stderr } = await execCommand(exe, ["--list-devices"], { timeout: 60_000, env });
    const found: { device: string; name: string }[] = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const match = /^\s*(ROCm\d+):\s*(.+?)\s*\(\d+ MiB/.exec(line);
      if (match) found.push({ device: match[1], name: match[2] });
    }
    return found;
  };
  let card: RocmCard | null = null;
  try {
    const all = await list();
    if (all.length === 1 && mine(all[0].name)) {
      card = { device: all[0].device, visible: null };
    } else if (all.some((found) => mine(found.name))) {
      for (let index = 0; index < 8 && !card; index++) {
        try {
          const only = await list({ ...process.env, HIP_VISIBLE_DEVICES: String(index) });
          if (only.length === 1 && mine(only[0].name)) card = { device: only[0].device, visible: String(index) };
        } catch {
          // Past the last device.
        }
      }
    }
  } catch {
    // Missing library, old driver: not usable.
  }
  rocmCards.set(key, card);
  return card;
}
/**
 * Windows: where the driver really put what this process allocated on the cards. An AMD
 * driver accepts an allocation it then keeps in system memory ("shared"), where the card
 * reads it many times slower, and the engine never learns about it (llama.cpp #30888).
 */
export async function processGpuMemory(pid: number): Promise<{ dedicatedMiB: number; sharedMiB: number } | null> {
  if (!IS_WINDOWS) return null;
  const script =
    `$r = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -like 'pid_${pid}_*' }; ` +
    "if ($r) { '{0} {1}' -f (($r | Measure-Object DedicatedUsage -Sum).Sum), (($r | Measure-Object SharedUsage -Sum).Sum) }";
  try {
    const { stdout } = await execCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 20_000 });
    const match = /^(\d+) (\d+)\s*$/m.exec(stdout);
    if (!match) return null;
    return { dedicatedMiB: Math.round(Number(match[1]) / 1048576), sharedMiB: Math.round(Number(match[2]) / 1048576) };
  } catch {
    return null;
  }
}

/**
 * Windows commit charge. Whatever the engine puts in VRAM is also reserved here
 * (measured: +16 GB of commit for 13 GB of VRAM, 1 GB of real RAM). The limit is
 * RAM + paging file: a small paging file makes the engine crash on load.
 */
export async function virtualMemory(): Promise<{ limitMiB: number; usedMiB: number } | null> {
  // Linux and macOS don't reserve system memory for what goes to VRAM.
  if (!IS_WINDOWS) return null;
  try {
    const { stdout } = await execCommand(
      "powershell.exe",
      ["-NoProfile", "-Command", "$o = Get-CimInstance Win32_OperatingSystem; \"$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)\""],
      { timeout: 20_000 },
    );
    const [total, free] = stdout.trim().split(/\s+/).map(Number);
    if (!total || !Number.isFinite(free)) return null;
    return { limitMiB: Math.floor(total / 1024), usedMiB: Math.floor((total - free) / 1024) };
  } catch {
    return null;
  }
}

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand(IS_WINDOWS ? "where.exe" : "which", [command], { timeout: 5_000 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/**
 * Command that starts Oh My Pi. The installer puts it in its own folder and it runs through
 * bun directly: Bun's global install could land in a user's stray ~/node_modules, and
 * the omp.exe launcher needs bun.exe on the PATH of whatever starts it.
 */
export async function findOmp(): Promise<string[] | null> {
  const cli = join(paths.base, "agent", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
  const bun = join(homedir(), ".bun", "bin", `bun${EXE}`);
  if (existsSync(cli) && existsSync(bun)) return [bun, cli];
  const bunGlobal = join(homedir(), ".bun", "bin", `omp${EXE}`);
  if (existsSync(bunGlobal)) return [bunGlobal];
  const found = await which("omp");
  return found ? [found] : null;
}

export async function ompVersion(command: string[]): Promise<string | null> {
  try {
    const { stdout } = await execCommand(command[0], [...command.slice(1), "--version"], { timeout: 15_000 });
    return stdout.trim().replace(/^omp\//, "") || null;
  } catch {
    return null;
  }
}

export async function hasNpx(): Promise<boolean> {
  return (await which("npx")) !== null;
}
