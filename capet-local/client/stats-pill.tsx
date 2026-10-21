import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { detailRows, pillLabel } from "../shared/format";
import { statsRpc } from "../shared/rpc";

const POLL_MS = 1000;

function StatsPopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const getStats = useRpc(statsRpc);
  const stats = useQuery({ queryKey: ["capet-local", "stats"], queryFn: () => getStats({}), refetchInterval: POLL_MS });
  const entry = stats.data?.agents.find((a) => a.agentId === agentId);
  const turn = entry?.current ?? entry?.last ?? null;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const text = { color: theme.colors.foreground, fontSize: 13 };

  return (
    <View style={{ padding: 16, gap: 8, minWidth: 300 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
        {turn?.outcome === "running" ? "Réponse en cours" : "Dernière réponse"}
      </Text>
      {turn ? (
        detailRows(turn).map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: 16 }}>
            <Text style={muted}>{label}</Text>
            <Text style={text}>{value}</Text>
          </View>
        ))
      ) : (
        <Text style={muted}>Pas encore de réponse pour cet agent.</Text>
      )}
    </View>
  );
}

/**
 * One composer pill per IA locale agent: live tok/s while it answers, then
 * total time and average speed. The plugin API registers pills per agent, so
 * poll the stats and add/update pills as agents show up.
 */
export function startStatsPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;

  const tick = async () => {
    let agents;
    try {
      ({ agents } = await client.rpc(statsRpc, {}));
    } catch {
      return; // Host offline or plugin reloading: try again next tick.
    }
    for (const entry of agents) {
      const turn = entry.current ?? entry.last;
      if (!turn || !entry.workspaceId) continue;
      const label = pillLabel(turn);
      const existing = pills.get(entry.agentId);
      if (existing) {
        existing.update({ label });
        continue;
      }
      pills.set(
        entry.agentId,
        client.addComposerPill({
          id: `stats-${entry.agentId}`,
          workspaceId: entry.workspaceId,
          agentId: entry.agentId,
          button: {
            title: "Vitesse de l'IA locale",
            icon: "Gauge",
            label,
            behavior: { kind: "popover", Content: StatsPopover },
          },
        }),
      );
    }
  };

  const loop = async () => {
    while (!stopped) {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  void loop();

  return () => {
    stopped = true;
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
