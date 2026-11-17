import { useAllSavedPanels, useDeleteSavedPanel } from "../api/useSavedPanels";
import { usedByWarning } from "@/utils/usedBy";
import type { SavedPanel } from "../api/types";
import { AdminList } from "./AdminList";

/** Saved panels (all): every saved panel, for those holding `zeteo.dashboards.read`. */
export const AdminSavedPanelsPage = () => (
  <AdminList<SavedPanel>
    title="Saved panels (all)"
    objectType="saved_panel"
    noun="saved panel"
    extraColumn={{
      title: "Used by",
      cell: (p) => {
        const n = p.used_by?.dashboards ?? 0;
        return n === 0 ? "—" : `${n} ${n === 1 ? "dashboard" : "dashboards"}`;
      },
    }}
    deleteText={(p) =>
      `Delete "${p.name}", owned by ${p.owner.name ?? p.owner.id}? It stops being shared and cannot be recovered.${
        p.used_by?.dashboards ? ` ${usedByWarning(p.used_by)}` : ""
      }`
    }
    useList={useAllSavedPanels}
    useRemove={useDeleteSavedPanel}
  />
);
