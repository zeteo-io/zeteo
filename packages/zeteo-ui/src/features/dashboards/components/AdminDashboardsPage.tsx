import { useDeleteDashboard } from "../api/useSaveDashboard";
import { useAllDashboards } from "../api/useDashboards";
import type { DashboardSummary } from "../api/types";
import { AdminList } from "./AdminList";

/** Dashboards (all): every dashboard, for those holding `zeteo.dashboards.read`. */
export const AdminDashboardsPage = () => (
  <AdminList<DashboardSummary>
    title="Dashboards (all)"
    objectType="dashboard"
    noun="dashboard"
    href={(d) => `/dashboards/${d.id}`}
    deleteText={(d) =>
      `Delete "${d.name}", owned by ${d.owner.name ?? d.owner.id}? Its panels go with it, it stops being shared, and it cannot be recovered.`
    }
    useList={useAllDashboards}
    useRemove={useDeleteDashboard}
  />
);
