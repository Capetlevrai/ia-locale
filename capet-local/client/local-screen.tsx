import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  applyRpc,
  cancelDownloadRpc,
  downloadModelRpc,
  installRuntimeRpc,
  statsRpc,
  statusRpc,
  stopRpc,
  type ModelStatus,
  type Progress,
  type Status,
} from "../shared/rpc";
import { localSettings, type LocalSettings, type Speculative } from "../shared/settings";
import { detailRows, latestTurn } from "../shared/format";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} Go`;
const ktok = (tokens: number) => `${Math.round(tokens / 1000)} K`;
const pct = (p: Progress) => (p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0);

function progressText(p: Progress | null): string | null {
  if (!p) return null;
  if (p.state === "running") return `${pct(p)} % — ${gb(p.done)} / ${gb(p.total)}`;
  if (p.state === "error") return `Erreur : ${p.error}`;
  return null;
}

const TIER_HINT: Record<ModelStatus["tier"], string> = {
  recommended: "★ Recommandé pour ta carte",
  compatible: "Compatible avec ta carte",
  tight: "Possible, contexte réduit",
  too_big: "Trop gros pour ta carte",
};

export function LocalScreen({ theme, layout }: PluginScreenProps) {
  const getStatus = useRpc(statusRpc);
  const status = useQuery({ queryKey: ["capet-local", "status"], queryFn: () => getStatus({}), refetchInterval: 1500 });
  const settings = useSettings(localSettings);
  const getStats = useRpc(statsRpc);
  const stats = useQuery({ queryKey: ["capet-local", "stats"], queryFn: () => getStats({}), refetchInterval: 1000 });

  const download = useMutation({ mutationFn: useRpc(downloadModelRpc) });
  const cancel = useMutation({ mutationFn: useRpc(cancelDownloadRpc) });
  const installRuntime = useMutation({ mutationFn: useRpc(installRuntimeRpc) });
  const apply = useMutation({ mutationFn: useRpc(applyRpc) });
  const stop = useMutation({ mutationFn: useRpc(stopRpc) });

  const styles = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 24, maxWidth: 820, width: "100%" as const, alignSelf: "center" as const },
      title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      text: { color: theme.colors.foreground, fontSize: 13 },
      ok: { color: theme.colors.statusSuccess, fontSize: 13 },
      warn: { color: theme.colors.statusWarning, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      barTrack: { height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" as const },
      log: {
        fontFamily: "monospace",
        fontSize: 11,
        color: theme.colors.foregroundMuted,
        backgroundColor: theme.colors.surface1,
        padding: 8,
        borderRadius: 6,
      },
    }),
    [theme, layout.compact],
  );

  if (!status.data || settings.status !== "ready") {
    return (
      <View style={[styles.scroll, { padding: 24 }]}>
        <Text style={styles.muted}>
          {status.error ? `Erreur : ${String(status.error)}` : settings.status === "error" ? settings.error : "Chargement…"}
        </Text>
      </View>
    );
  }

  const s: Status = status.data;
  const values = settings.values;
  const save = (patch: Partial<LocalSettings>) => void settings.save({ ...values, ...patch }, settings.revision);

  const lastTurn = stats.data ? latestTurn(stats.data.agents) : null;
  const selected = s.models.find((m) => m.id === values.modelId) ?? null;
  const mcpEnabled = (id: string, fallback: boolean) => values.mcp[id] ?? fallback;
  const mcpTokens = s.mcp.reduce((sum, m) => sum + (mcpEnabled(m.id, m.enabledByDefault) ? m.tokens : 0), 0);
  const startupTokens = s.agentBaseTokens + mcpTokens + (values.paseoTools ? 3000 : 0);
  const budgetCtx = s.budgetOptions.find((o) => o.gb === values.vramBudgetGb)?.estCtx ?? null;
  const ctx =
    s.engine.ctx ?? (values.contextMode === "manual" ? values.contextTokens : values.contextMode === "budget" ? budgetCtx : null);
  const dirty = s.engine.appliedRevision !== null && s.engine.appliedRevision !== settings.revision;
  const ready = s.runtime.installed && s.omp.installed && !!selected?.installed;

  const engineLine = {
    stopped: { style: styles.muted, text: "Arrêté — il démarrera tout seul quand un agent IA locale parle." },
    starting: { style: styles.warn, text: "Chargement du modèle sur la carte graphique…" },
    ready: { style: styles.ok, text: `Prêt — ${selected?.label ?? s.engine.modelId}` },
    error: { style: styles.danger, text: s.engine.error ?? "Erreur" },
  }[s.engine.state];

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>IA locale</Text>
        <Text style={styles.muted}>
          Fais tourner un agent de code sur ta propre carte graphique. Suis les étapes de haut en bas.
        </Text>
      </View>

      <SettingsSection title="1. Ta machine">
        <SettingsRow
          label="Carte graphique"
          hint={
            s.gpu
              ? s.gpu.vendor === "apple"
                ? `${s.gpu.name} — ${(s.gpu.vramTotalMiB / 1024).toFixed(0)} Go de mémoire utilisables par l'IA (partagée avec le Mac), ` +
                  `${(s.gpu.vramFreeMiB / 1024).toFixed(1)} Go libres. Mac : prise en charge expérimentale`
                : `${s.gpu.name} — ${(s.gpu.vramTotalMiB / 1024).toFixed(0)} Go de VRAM, ${(s.gpu.vramFreeMiB / 1024).toFixed(1)} Go libres` +
                  (s.gpu.cards > 1 ? ` (l'IA locale utilise seulement cette carte sur les ${s.gpu.cards})` : "") +
                  (s.gpu.vendor === "nvidia" ? "" : ". Cartes AMD et Intel : prise en charge expérimentale")
              : undefined
          }
          error={s.gpu ? null : "Aucune carte graphique détectée. Il faut une carte NVIDIA, AMD ou Intel avec son pilote à jour, ou un Mac à puce Apple (M1 ou plus récent)."}
        />
        {s.runtime.installed ? (
          <SettingsRow label="Moteur d'IA" hint={`${s.runtime.label} — installé`} />
        ) : (
          <SettingsAction
            label="Moteur d'IA"
            hint={progressText(s.runtime.download) ?? `${s.runtime.label} — environ ${s.runtime.sizeMb} Mo à télécharger`}
            error={s.runtime.download?.state === "error" ? s.runtime.download.error : null}
            actionLabel={s.runtime.download?.state === "running" ? "Installation…" : "Installer"}
            disabled={!s.gpu || s.runtime.download?.state === "running"}
            onPress={() => installRuntime.mutate({})}
          />
        )}
        <SettingsRow
          label="Agent Oh My Pi"
          hint={s.omp.installed ? `Installé (${s.omp.version ?? "version inconnue"})` : undefined}
          error={s.omp.installed ? null : "Oh My Pi n'est pas installé. L'installateur Capet Local s'en charge."}
        />
      </SettingsSection>

      <SettingsSection title="2. Modèle">
        {s.models.map((m) => {
          const running = m.download?.state === "running";
          const active = values.modelId === m.id;
          const hint =
            progressText(m.download) ??
            `${m.technical} — ${gb(m.sizeBytes)}\n${m.description ? `${m.description}\n` : ""}${TIER_HINT[m.tier]} · huggingface.co/${m.repo}`;
          if (!m.installed) {
            return (
              <SettingsAction
                key={m.id}
                label={m.label}
                hint={hint}
                actionLabel={running ? "Annuler" : "Télécharger"}
                disabled={m.tier === "too_big" && !running}
                onPress={() => (running ? cancel.mutate({ modelId: m.id }) : download.mutate({ modelId: m.id, part: "model" }))}
              />
            );
          }
          return (
            <SettingsAction
              key={m.id}
              label={active ? `✓ ${m.label}` : m.label}
              hint={hint}
              actionLabel={active ? "Choisi" : "Utiliser"}
              disabled={active}
              onPress={() => save({ modelId: m.id })}
            />
          );
        })}
      </SettingsSection>

      {selected && (
        <SettingsSection title="3. Vitesse et vision">
          <SettingsSelect<Speculative>
            label="Accélération"
            hint={
              values.speculative === "dflash"
                ? "DFlash : environ +20 % de vitesse, mais l'agent ne voit plus les images."
                : "MTP : le modèle devine plusieurs mots d'un coup. Plus rapide, même qualité."
            }
            value={values.speculative}
            options={[
              { value: "auto", label: "Automatique (MTP)" },
              { value: "none", label: "Aucune" },
              ...(selected.features.mtp ? [{ value: "mtp" as const, label: "MTP" }] : []),
              ...(selected.features.dflash ? [{ value: "dflash" as const, label: "DFlash (texte seulement)" }] : []),
            ]}
            onValueChange={(speculative) => save({ speculative })}
          />
          {values.speculative === "dflash" && !selected.dflashInstalled && (
            <SettingsAction
              label="Module DFlash"
              hint={progressText(selected.dflashDownload) ?? "Petit modèle d'accélération, environ 1,1 Go."}
              actionLabel={selected.dflashDownload?.state === "running" ? "Annuler" : "Télécharger"}
              onPress={() =>
                selected.dflashDownload?.state === "running"
                  ? cancel.mutate({ modelId: selected.id })
                  : download.mutate({ modelId: selected.id, part: "dflash" })
              }
            />
          )}
          {selected.features.vision && (
            <SettingsSwitch
              label="Comprendre les images"
              hint={
                values.speculative === "dflash"
                  ? "Indisponible avec DFlash."
                  : values.visionOnCpu
                    ? "Sur le processeur : aucune VRAM en plus."
                    : "Utilise environ 1 Go de VRAM en plus."
              }
              value={values.vision && values.speculative !== "dflash"}
              disabled={values.speculative === "dflash"}
              onValueChange={(vision) => save({ vision })}
            />
          )}
          {selected.features.vision && values.vision && values.speculative !== "dflash" && (
            <SettingsSwitch
              label="Vision sur le processeur"
              hint="Libère environ 1 Go de VRAM, soit plus de contexte, mais chaque image est lue beaucoup plus lentement (jusqu'à une minute pour une capture d'écran sur un PC lent). À garder désactivé, sauf si le contexte manque."
              value={values.visionOnCpu}
              onValueChange={(visionOnCpu) => save({ visionOnCpu })}
            />
          )}
        </SettingsSection>
      )}

      {selected && (
        <SettingsSection title="4. Mémoire de travail (contexte)">
          <SettingsSelect<LocalSettings["contextMode"]>
            label="Taille du contexte"
            hint={CONTEXT_HINT[values.contextMode]}
            value={values.contextMode}
            options={[
              { value: "auto", label: "Automatique (recommandé)" },
              { value: "budget", label: "Budget VRAM" },
              { value: "manual", label: "Manuel (tokens)" },
            ]}
            onValueChange={(contextMode) => {
              if (contextMode === "budget" && values.vramBudgetGb === 0) {
                // First time: leave 4 GB free (OBS, browser…) when the card allows it.
                const top = s.budgetOptions.at(-1)?.gb ?? 0;
                const first = s.budgetOptions[0]?.gb ?? top;
                save({ contextMode, vramBudgetGb: Math.max(first, top - 4) });
              } else {
                save({ contextMode });
              }
            }}
          />
          {values.contextMode === "budget" &&
            (s.budgetOptions.length === 0 ? (
              <SettingsRow label="VRAM à utiliser" error="Ce modèle ne tient pas sur ta carte : choisis un modèle plus petit." />
            ) : (
              <SettingsSelect<string>
                label="VRAM à utiliser"
                hint={budgetSelectHint(s, values.vramBudgetGb)}
                value={String(values.vramBudgetGb)}
                options={s.budgetOptions.map((o) => ({
                  value: String(o.gb),
                  label: `${o.gb} Go — ≈ ${ktok(o.estCtx)} tokens`,
                }))}
                onValueChange={(v) => save({ vramBudgetGb: Number(v) })}
              />
            ))}
          {values.contextMode === "manual" && (
            <ManualContext value={values.contextTokens} onSave={(contextTokens) => save({ contextTokens })} />
          )}
          {s.engine.state === "ready" && s.engine.ctx && (
            <SettingsRow
              label="Mesuré au dernier chargement"
              hint={
                `Contexte ${ktok(s.engine.ctx)} tokens` +
                (s.engine.vramUsedMiB ? `, ${(s.engine.vramUsedMiB / 1024).toFixed(1)} Go de VRAM utilisés` : "") +
                (s.engine.vramBudgetMiB ? ` sur ${(s.engine.vramBudgetMiB / 1024).toFixed(0)} Go autorisés.` : ".")
              }
            />
          )}
          <SettingsSwitch
            label="Limiter la réflexion"
            hint={
              values.reasoningLimit
                ? "Le modèle réfléchit au plus ≈ 4 K tokens en effort Faible, 12 K en Moyen, 32 K en Très élevé, puis passe à l'action. Évite d'attendre de longues minutes."
                : "Réflexion sans limite : parfois meilleure sur les problèmes très durs, mais peut durer de longues minutes en Très élevé."
            }
            value={values.reasoningLimit}
            onValueChange={(reasoningLimit) => save({ reasoningLimit })}
          />
          <SettingsSwitch
            label="Compaction optimisée pour le local"
            hint={
              values.localCompaction
                ? compactHint(values.compactPercent, ctx)
                : "Désactivée : réglages d'origine d'Oh My Pi, pensés pour le cloud (résumé dès ~82 % du contexte, souvent lent en local)."
            }
            value={values.localCompaction}
            onValueChange={(localCompaction) => save({ localCompaction })}
          />
          {values.localCompaction && (
            <SettingsSelect<string>
              label="Alléger la conversation à"
              value={String(values.compactPercent)}
              options={[
                { value: "85", label: "85 %" },
                { value: "90", label: "90 %" },
                { value: "95", label: "95 % (recommandé)" },
              ]}
              onValueChange={(v) => save({ compactPercent: Number(v) })}
            />
          )}
          <SettingsRow label="Utilisé au démarrage d'un agent" hint={budgetHint(startupTokens, ctx)}>
            {ctx ? <BudgetBar used={startupTokens} total={ctx} styles={styles} colors={theme.colors} /> : null}
          </SettingsRow>
        </SettingsSection>
      )}

      {selected && (
        <SettingsSection title="5. Outils de l'agent (MCP)">
          <Text style={styles.muted}>
            Chaque outil coûte du contexte à chaque conversation. N'active que ce dont tu as besoin.
          </Text>
          {s.mcp.map((m) => (
            <SettingsSwitch
              key={m.id}
              label={m.label}
              hint={`${m.description} ≈ ${(m.tokens / 1000).toFixed(1)} K tokens.`}
              error={m.available ? null : "Nécessite Node.js (npx)."}
              value={mcpEnabled(m.id, m.enabledByDefault)}
              disabled={!m.available}
              onValueChange={(on) => save({ mcp: { ...values.mcp, [m.id]: on } })}
            />
          ))}
          <SettingsSwitch
            label="Outils Paseo"
            hint="Laisse l'agent piloter Paseo (créer d'autres agents…). ≈ 3 K tokens."
            value={values.paseoTools}
            onValueChange={(paseoTools) => save({ paseoTools })}
          />
        </SettingsSection>
      )}

      <SettingsSection title="6. Démarrer">
        <SettingsRow
          label="État"
          hint={s.engine.notice ? `${engineLine.text}\n${s.engine.notice}` : engineLine.text}
          error={dirty ? "Réglages modifiés : clique sur Appliquer." : null}
        >
          <Text style={engineLine.style}>●</Text>
        </SettingsRow>
        <SettingsAction
          label="Appliquer et charger le modèle"
          hint={
            apply.data?.message ??
            (ready ? "Lance le modèle avec ces réglages et ajoute l'agent « IA locale » dans Paseo." : "Termine les étapes 1 et 2 d'abord.")
          }
          error={apply.data && !apply.data.ok ? apply.data.message : null}
          actionLabel="Appliquer"
          disabled={!ready || s.engine.state === "starting"}
          onPress={() => apply.mutate({})}
        />
        {s.engine.state !== "stopped" && (
          <SettingsAction
            label="Libérer la carte graphique"
            hint="Décharge le modèle (pour jouer, par exemple)."
            actionLabel="Arrêter"
            onPress={() => stop.mutate({})}
          />
        )}
        <SettingsSelect<string>
          label="Libérer automatiquement après"
          value={String(values.idleMinutes)}
          options={[
            { value: "0", label: "Jamais" },
            { value: "15", label: "15 min d'inactivité" },
            { value: "30", label: "30 min d'inactivité" },
            { value: "60", label: "1 h d'inactivité" },
          ]}
          onValueChange={(v) => save({ idleMinutes: Number(v) })}
        />
        {s.engine.state === "ready" && (
          <Text style={styles.text}>
            C'est prêt : crée un nouvel agent et choisis « IA locale » comme fournisseur.
          </Text>
        )}
        {lastTurn && (
          <View style={{ gap: 4, paddingVertical: 8 }}>
            <Text style={[styles.text, { fontWeight: "600" }]}>
              {lastTurn.outcome === "running" ? "Réponse en cours" : "Dernière réponse"}
            </Text>
            {detailRows(lastTurn).map(([label, value]) => (
              <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: 16 }}>
                <Text style={styles.muted}>{label}</Text>
                <Text style={styles.text}>{value}</Text>
              </View>
            ))}
          </View>
        )}
        {/* Technical log only when something went wrong. */}
        {s.engine.state === "error" && s.engine.logTail.length > 0 && (
          <Text style={styles.log}>{s.engine.logTail.slice(-8).join("\n")}</Text>
        )}
      </SettingsSection>

      <Text style={styles.muted}>Fichiers : {s.dataDir}</Text>
    </ScrollView>
  );
}

const CONTEXT_HINT: Record<LocalSettings["contextMode"], string> = {
  auto: "Automatique : tout ce que ta carte peut tenir, calculé au démarrage.",
  budget: "Budget VRAM : tu choisis combien de Go l'IA a le droit d'utiliser, le contexte s'adapte. Idéal si tu streames ou joues en même temps.",
  manual: "Manuel : tu fixes le nombre de tokens. Si c'est trop grand, le modèle ne démarrera pas.",
};

function budgetSelectHint(s: Status, budgetGb: number): string {
  if (!s.gpu) return "";
  const totalGb = s.gpu.vramTotalMiB / 1024;
  const left = Math.max(0, totalGb - budgetGb);
  return `Ta carte a ${totalGb.toFixed(0)} Go : il restera ≈ ${left.toFixed(0)} Go pour le système et tes autres logiciels (OBS, jeux, navigateur…).`;
}

function compactHint(percent: number, ctx: number | null): string {
  // Mirrors server/omp.ts localCompaction(): percent of the context, 8K always kept free.
  const at = ctx ? Math.max(Math.floor(ctx / 2), Math.min(Math.floor((ctx * percent) / 100), ctx - 8192)) : null;
  return (
    `Quand la mémoire de travail est pleine${at ? ` (vers ${ktok(at)} tokens)` : ` à ${percent} %`}, l'agent retire d'abord ` +
    "les vieux résultats d'outils (instantané) et ne fait un résumé que si ça ne suffit pas. 8 K tokens restent toujours libres."
  );
}

function budgetHint(used: number, ctx: number | null): string {
  if (!ctx) return `≈ ${ktok(used)} tokens avant ton premier message.`;
  const share = Math.round((used / ctx) * 100);
  return `≈ ${ktok(used)} sur ${ktok(ctx)} tokens (${share} %) avant ton premier message. Il reste ${ktok(ctx - used)} pour travailler.`;
}

function ManualContext({ value, onSave }: { value: number; onSave(tokens: number): void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsInput
      label="Contexte (tokens)"
      hint="Entre 8 192 et 262 144. 65 536 est un bon départ sur 16 Go."
      error={error}
      initialValue={String(value)}
      onChangeText={(text) => {
        const n = Number(text.replace(/\s/g, ""));
        if (!Number.isInteger(n) || n < 8192 || n > 262144) {
          setError("Nombre entre 8192 et 262144");
          return;
        }
        setError(null);
        onSave(n);
      }}
    />
  );
}

function BudgetBar({
  used,
  total,
  styles,
  colors,
}: {
  used: number;
  total: number;
  styles: { barTrack: object };
  colors: { accent: string; statusWarning: string };
}) {
  const share = Math.min(1, used / total);
  return (
    <View style={[styles.barTrack, { width: 160 }]}>
      <View style={{ width: `${share * 100}%`, height: "100%", backgroundColor: share > 0.3 ? colors.statusWarning : colors.accent }} />
    </View>
  );
}
