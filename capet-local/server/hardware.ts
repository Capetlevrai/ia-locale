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
  ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.VendorId, $_.DedicatedVideoMemory, $used[[int64]$_.AdapterLuid], $_.Description }
`;

export async function detectOtherGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execCommand("powershell.exe", ["-NoProfile", "-Command", OTHER_GPUS_PS], { timeout: 20_000 });
    const MIB = 1024 * 1024;
    const gpus = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split("|"))
      .filter((f) => f.length >= 4 && Number(f[1]) > 0)
      .map(([vendorId, total, used, ...name]) => {
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
  };
}

/**
 * llama.cpp's name for a card in its Vulkan engine ("Vulkan1"), to pin it with --device.
 * Vulkan and DirectX name cards the same way, give or take (R)/(TM) marks.
 */
export async function vulkanDevice(exe: string, gpuName: string): Promise<string | null> {
  const norm = (s: string) => s.toLowerCase().replace(/\((r|tm)\)/g, "").replace(/\s+/g, " ").trim();
  try {
    const { stdout, stderr } = await execCommand(exe, ["--list-devices"], { timeout: 30_000 });
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const match = /^\s*(Vulkan\d+):\s*(.+?)\s*\(\d+ MiB/.exec(line);
      if (match && norm(match[2]) === norm(gpuName)) return match[1];
    }
  } catch {
    // Unpinned: llama.cpp then uses every dedicated card.
  }
  return null;
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
