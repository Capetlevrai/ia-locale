import type { PluginHostProps, PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  applyRpc,
  cancelDownloadRpc,
  downloadModelRpc,
  statusRpc,
  stopRpc,
  type EngineState,
  type ModelStatus,
  type Progress,
} from "../shared/rpc";
import { localSettings } from "../shared/settings";

type Colors = PluginHostProps["theme"]["colors"];

export const PANEL_ID = "panel";
/** Paseo's key for this row in its sidebar settings: plugin:<plugin id>:<item id>. */
const PANEL_KEY = `plugin:capet-local:${PANEL_ID}`;
const POLL_MS = 2000;

const go = (mib: number) => (mib / 1024).toFixed(1).replace(".", ",");
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} Go`;
const percent = (p: Progress) => (p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0);
/** server/download.ts reports a cancel as an error with this message. */
const CANCELED = "Annulé";
/** "NVIDIA GeForce RTX 4090" -> "RTX 4090", "Intel(R) Arc(TM) A770 Graphics" -> "Arc A770". */
const shortGpu = (name: string) =>
  name
    .replace(/\((R|TM)\)/gi, "")
    .replace(/^(NVIDIA|AMD|Intel)\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .replace(/^(\S+\s+\S+.*?)\s+Graphics$/i, "$1")
    .trim();
/** Paseo's theme colors are #rrggbb: append an alpha byte for a tint. */
const tint = (color: string, alpha: string) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : undefined);
/** Pressable's state on web also carries `hovered`. */
const hovered = (state: object) => (state as { hovered?: boolean }).hovered === true;

function dotColor(state: EngineState, c: Colors): string {
  return { ready: c.statusSuccess, starting: c.statusWarning, error: c.statusDanger, stopped: c.foregroundMuted }[state];
}

/** Same query as the IA locale screen, so both share one poll. */
function useStatus() {
  const getStatus = useRpc(statusRpc);
  return useQuery({ queryKey: ["capet-local", "status"], queryFn: () => getStatus({}), refetchInterval: POLL_MS });
}

/** Tell the user when a model download started from the panel (or the screen) ends. */
function useDownloadToasts(models: ModelStatus[] | undefined): void {
  const toast = useToast();
  const watching = useRef(new Set<string>());
  useEffect(() => {
    for (const m of models ?? []) {
      if (m.download?.state === "running") {
        watching.current.add(m.id);
      } else if (watching.current.delete(m.id)) {
        if (m.installed) toast.show(`${m.label} est téléchargé : choisis-le dans le panneau IA locale.`, { variant: "success" });
        else if (m.download?.state === "error" && m.download.error !== CANCELED) {
          toast.error(`Téléchargement de ${m.label} : ${m.download.error}`);
        }
      }
    }
  }, [models, toast]);
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where Paseo's desktop and web app save their settings (AsyncStorage on web). */
const APP_SETTINGS_STORAGE = "@paseo:app-settings";

/**
 * Paseo lists its own footer rows (the Claude/GPT usage meters) before plugin rows.
 * Put the panel above them once, as the user could by hand in Paseo's sidebar settings;
 * after that the order chosen there wins. Plugins only see their own query cache, not
 * the app's settings in memory, so this edits the saved copy: it shows from the next
 * start of Paseo. The phone app's storage is out of reach and keeps Paseo's order.
 */
export function placePanelAboveUsage(): void {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    const saved = storage?.getItem(APP_SETTINGS_STORAGE);
    // No saved settings yet: Paseo's defaults hide the usage meters anyway.
    if (!storage || !saved) return;
    const settings = JSON.parse(saved) as Record<string, unknown>;
    const items = settings.sidebarFooterItems ?? [];
    if (!Array.isArray(items) || items.some((item: { key?: unknown }) => item?.key === PANEL_KEY)) return;
    storage.setItem(APP_SETTINGS_STORAGE, JSON.stringify({ ...settings, sidebarFooterItems: [{ key: PANEL_KEY, visible: true }, ...items] }));
  } catch {
    // Not the settings shape this was written for (Paseo 0.11): leave its order alone.
  }
}

type Glyph = "play" | "stop" | "settings" | "loading";

/** Filled play/stop shapes: crisper than outline icons at this size. */
function GlyphView({ glyph, color }: { glyph: Glyph; color: string }) {
  switch (glyph) {
    case "play":
      return (
        <View
          style={{
            marginLeft: 1,
            borderLeftWidth: 7,
            borderTopWidth: 4.5,
            borderBottomWidth: 4.5,
            borderLeftColor: color,
            borderTopColor: "transparent",
            borderBottomColor: "transparent",
          }}
        />
      );
    case "stop":
      return <View style={{ width: 8, height: 8, borderRadius: 1.5, backgroundColor: color }} />;
    case "settings":
      return <Icon name="Settings" size={13} color={color} />;
    case "loading":
      return <ActivityIndicator size="small" color={color} style={{ width: 12, height: 12, transform: [{ scale: 0.6 }] }} />;
  }
}

/**
 * One half of the start/stop control. The action available now is a solid button
 * in its color; the other one stays as plain text on the track.
 */
function ActionButton({
  label,
  glyph,
  color,
  enabled,
  onPress,
  c,
}: {
  label: string;
  glyph: Glyph;
  color: string;
  enabled: boolean;
  onPress(): void;
  c: Colors;
}) {
  // surface0 is the theme's page color: dark text on the dark theme's light status
  // colors, white text on the light theme's deep ones.
  const fg = enabled ? c.surface0 : c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={(st) => ({
        flex: 1,
        height: 28,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        borderRadius: 7,
        backgroundColor: enabled ? color : "transparent",
        opacity: enabled ? (st.pressed ? 0.8 : hovered(st) ? 0.9 : 1) : 0.65,
      })}
    >
      <GlyphView glyph={glyph} color={fg} />
      <Text numberOfLines={1} style={{ color: fg, fontSize: 13, fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Sidebar footer panel: model picker and start/stop above, graphics card and VRAM
 * meter below, so the engine can be driven without opening the IA locale screen.
 */
export function GpuPanel({ theme, openScreen, openPopover }: PluginSidebarItemProps) {
  const c = theme.colors;
  const status = useStatus();
  useDownloadToasts(status.data?.models);
  const settings = useSettings(localSettings);
  const apply = useRpc(applyRpc);
  const stop = useRpc(stopRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const s = status.data;
  if (!s) return null;

  const modelId = settings.status === "ready" ? settings.values.modelId : null;
  const selected = s.models.find((m) => m.id === modelId) ?? null;
  const ready = !!s.gpu && s.runtime.installed && s.omp.installed && !!selected?.installed;
  const state = s.engine.state;
  const running = state === "ready" || state === "starting";
  const openLocal = () => openScreen({ screenId: "local" });

  const run = async (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok && result.message) toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["capet-local", "status"] });
      setBusy(false);
    }
  };

  // Not set up yet (model not downloaded…): the start button leads to the IA locale screen.
  const start = !ready
    ? { label: "Configurer", glyph: "settings" as const, color: c.foreground, enabled: true, onPress: openLocal }
    : {
        label: state === "starting" ? "Chargement…" : state === "error" ? "Relancer" : "Lancer",
        glyph: state === "starting" ? ("loading" as const) : ("play" as const),
        color: c.statusSuccess,
        enabled: !running && !busy,
        onPress: () => void run(() => apply({})),
      };

  const gpu = s.gpu;
  // The engine's measured share, shown apart from what other programs use.
  const usedMiB = gpu ? Math.min(gpu.vramUsedMiB, gpu.vramTotalMiB) : 0;
  const engineMiB = state === "ready" ? Math.min(usedMiB, s.engine.vramUsedMiB ?? usedMiB) : 0;
  const share = (mib: number): `${number}%` => (gpu && gpu.vramTotalMiB > 0 ? `${(mib / gpu.vramTotalMiB) * 100}%` : "0%");

  const download = s.models.find((m) => m.download?.state === "running")?.download ?? null;
  const line =
    state === "error"
      ? { text: "Erreur : voir IA locale", color: c.statusDanger }
      : state === "starting"
        ? { text: "Chargement du modèle…", color: c.statusWarning }
        : download
          ? { text: `Téléchargement ${percent(download)} %`, color: c.accent }
          : { text: gpu ? shortGpu(gpu.name) : "Aucune carte graphique", color: c.foregroundMuted };

  return (
    <View style={{ gap: 4, paddingBottom: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Modèle IA locale : ${selected?.label ?? "aucun"}. Changer de modèle`}
        onPress={() => openPopover(ModelPicker)}
        style={(st) => ({
          minHeight: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 8,
          borderRadius: 8,
          backgroundColor: hovered(st) || st.pressed ? c.surface1 : "transparent",
        })}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor(state, c) }} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 13 }}>
          {selected?.label ?? "Choisir un modèle"}
        </Text>
        <Icon name="ChevronsUpDown" size={14} color={c.foregroundMuted} />
      </Pressable>
      <View style={{ flexDirection: "row", gap: 2, padding: 2, marginHorizontal: 2, borderRadius: 9, backgroundColor: c.surface1 }}>
        <ActionButton {...start} c={c} />
        <ActionButton
          label="Arrêter"
          glyph="stop"
          color={c.statusDanger}
          enabled={running && !busy}
          onPress={() => void run(() => stop({}))}
          c={c}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          gpu ? `${shortGpu(gpu.name)}, ${go(usedMiB)} Go de VRAM utilisés sur ${go(gpu.vramTotalMiB)}. Ouvrir IA locale` : "Ouvrir IA locale"
        }
        onPress={openLocal}
        style={(st) => ({
          gap: 5,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: hovered(st) || st.pressed ? c.surface1 : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: line.color, fontSize: 12 }}>
            {line.text}
          </Text>
          {gpu && (
            <Text style={{ color: c.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
              {go(usedMiB)}
              <Text style={{ color: c.foregroundMuted }}> / {Math.round(gpu.vramTotalMiB / 1024)} Go</Text>
            </Text>
          )}
        </View>
        {gpu && (
          <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2, flexDirection: "row", overflow: "hidden" }}>
            <View style={{ width: share(engineMiB), backgroundColor: c.accent }} />
            <View style={{ width: share(usedMiB - engineMiB), backgroundColor: tint(c.foregroundMuted, "99") ?? c.foregroundMuted }} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

function ModelPicker({ theme, close, openScreen }: PluginPopoverProps) {
  const c = theme.colors;
  const status = useStatus();
  const settings = useSettings(localSettings);
  const apply = useRpc(applyRpc);
  const download = useRpc(downloadModelRpc);
  const cancel = useRpc(cancelDownloadRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  const s = status.data;
  if (!s || settings.status !== "ready") {
    return (
      <View style={{ padding: 12, minWidth: 260 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Chargement…</Text>
      </View>
    );
  }

  const values = settings.values;
  const openLocal = () => {
    close();
    openScreen({ screenId: "local" });
  };

  const choose = async (modelId: string) => {
    if (modelId === values.modelId) return close();
    const saved = await settings.save({ ...values, modelId }, settings.revision);
    close();
    if (!saved) return toast.error("Le choix du modèle n'a pas été enregistré.");
    // A loaded engine switches to the new model right away.
    if (s.engine.state === "ready" || s.engine.state === "starting") {
      const result = await apply({});
      if (!result.ok) toast.error(result.message);
    }
  };

  // The list stays open: the row shows the progress, and the model can be chosen once it is there.
  const startDownload = async (m: ModelStatus) => {
    try {
      const result = await download({ modelId: m.id, part: "model" });
      if (result.ok) toast.show(`Téléchargement de ${m.label} lancé (${gb(m.sizeBytes)}).`, { variant: "info" });
      else toast.error(result.message ?? "Téléchargement impossible.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    await queryClient.invalidateQueries({ queryKey: ["capet-local", "status"] });
  };

  const stopDownload = async (m: ModelStatus) => {
    await cancel({ modelId: m.id }).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: ["capet-local", "status"] });
  };

  const rowStyle = (st: object & { pressed: boolean }) => ({
    minHeight: 34,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: hovered(st) || st.pressed ? c.surface2 : "transparent",
  });

  return (
    <View style={{ padding: 6, minWidth: 260, gap: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 10, paddingVertical: 6 }}>Modèle IA locale</Text>
      {s.models
        .filter((m) => m.installed || m.tier !== "too_big")
        .map((m) => {
          const active = m.id === values.modelId;
          const dl = m.download;
          const downloading = !m.installed && dl?.state === "running";
          const failed = !m.installed && dl?.state === "error" && dl.error !== CANCELED;
          const label = m.installed
            ? m.label
            : downloading
              ? `${m.label} : téléchargement ${percent(dl)} %`
              : failed
                ? `${m.label} : échec du téléchargement (${dl.error}). Réessayer`
                : `${m.label} : télécharger (${gb(m.sizeBytes)})`;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
              onPress={() => {
                if (m.installed) void choose(m.id);
                else if (!downloading) void startDownload(m);
              }}
              style={rowStyle}
            >
              <View style={{ width: 14 }}>{active && <Icon name="Check" size={14} color={c.accent} />}</View>
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: m.installed ? c.foreground : c.foregroundMuted, fontSize: 13 }}>
                {m.label}
              </Text>
              {m.installed ? (
                m.tier === "recommended" ? <Text style={{ color: c.accent, fontSize: 12 }}>★</Text> : null
              ) : downloading ? (
                <>
                  <Text style={{ color: c.accent, fontSize: 12, fontVariant: ["tabular-nums"] }}>{percent(dl)} %</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Annuler le téléchargement de ${m.label}`}
                    hitSlop={8}
                    onPress={() => void stopDownload(m)}
                  >
                    <Icon name="X" size={14} color={c.foregroundMuted} />
                  </Pressable>
                </>
              ) : failed ? (
                <>
                  <Text style={{ color: c.statusDanger, fontSize: 12 }}>Échec</Text>
                  <Icon name="RotateCw" size={14} color={c.statusDanger} />
                </>
              ) : (
                <>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{gb(m.sizeBytes)}</Text>
                  <Icon name="Download" size={14} color={c.foregroundMuted} />
                </>
              )}
            </Pressable>
          );
        })}
      <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
      <Pressable accessibilityRole="button" onPress={openLocal} style={rowStyle}>
        <Icon name="Settings" size={14} color={c.foregroundMuted} />
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 13 }}>Tous les réglages</Text>
      </Pressable>
    </View>
  );
}
