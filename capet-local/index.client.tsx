import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GpuPanel, PANEL_ID, placePanelAboveUsage } from "./client/gpu-panel";
import { LocalScreen } from "./client/local-screen";
import { startStatsPills } from "./client/stats-pill";

function LocalItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Cpu"
      active={currentScreen?.screenId === "local"}
      onPress={() => openScreen({ screenId: "local" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  placePanelAboveUsage();
  const cleanups = [
    client.addScreen({ id: "local", title: "IA locale", Component: LocalScreen }),
    client.addSidebarHeaderItem({ id: "local", title: "IA locale", Component: LocalItem }),
    client.addSidebarFooterItem({ id: PANEL_ID, title: "IA locale : carte graphique", Component: GpuPanel }),
    client.addCommandCenterItem({
      id: "open-local",
      title: "IA locale : réglages",
      icon: "Cpu",
      keywords: ["local", "llama", "modèle", "gpu"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "local" }),
    }),
    startStatsPills(client),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
