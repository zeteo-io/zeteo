import { isTab, TABS, dashboardsHref, type DashboardsTab } from "./tabs";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCreateDashboard } from "../api/useSaveDashboard";
import { Button, Card, Spinner } from "@kosmeo-ui/react";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useDashboards } from "../api/useDashboards";
import type { DashboardSummary } from "../api/types";
import { SavedPanelsPage } from "./SavedPanelsPage";
import { formatDate } from "@/utils/formatDate";
import { NameDialog } from "./DashboardDialogs";
import { useState } from "react";
import "./styles.css";

const DashboardCard = ({
  dashboard: d,
  shared,
}: {
  dashboard: DashboardSummary;
  shared: boolean;
}) => (
  <Card>
    <div className="z-db-card" data-dashboard={d.id}>
      <h3>
        <Link to={`/dashboards/${d.id}`}>{d.name}</Link>
      </h3>
      {d.description ? (
        <p>{d.description}</p>
      ) : (
        <p className="z-note">No description.</p>
      )}
      <p className="z-note">
        {shared && <>From {d.owner.name ?? "someone"} · </>}
        Updated{" "}
        <time dateTime={d.updated_at} title={formatDate(d.updated_at)}>
          {formatRelative(d.updated_at)}
        </time>
      </p>
    </div>
  </Card>
);

const DashboardList = ({ scope }: { scope: "mine" | "shared" }) => {
  const list = useDashboards(scope);
  return (
    <>
      {list.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={list.error} />
      {!list.isLoading && !list.error && list.items.length === 0 && (
        <p className="z-note">
          {scope === "mine"
            ? "You have no dashboards yet. Make one from your saved queries."
            : "No dashboards have been shared with you yet."}
        </p>
      )}
      {list.items.length > 0 && (
        <div className="z-db-grid">
          {list.items.map((d) => (
            <DashboardCard
              key={d.id}
              dashboard={d}
              shared={scope === "shared"}
            />
          ))}
        </div>
      )}
      {list.hasMore && (
        <div className="z-my-more">
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={list.loadMore}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
};

/** The Dashboards section: my dashboards, those shared with me, and saved panels. */
export const DashboardsPage = () => {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  const tab: DashboardsTab = isTab(raw) ? raw : "mine";
  const create = useCreateDashboard();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [creatingPanel, setCreatingPanel] = useState(false);

  const action =
    tab === "panels" ? (
      <Button
        size="sm"
        fullWidth={false}
        onClick={() => setCreatingPanel(true)}
      >
        New saved panel
      </Button>
    ) : (
      <Button size="sm" fullWidth={false} onClick={() => setCreating(true)}>
        New dashboard
      </Button>
    );

  return (
    <>
      <div className="z-my-header">
        <PageHeader title="Dashboards" actions={action} divider={false} />
      </div>
      <nav className="z-source-tabs" aria-label="Dashboards">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={dashboardsHref(t.id)}
            className={`z-source-tab${t.id === tab ? " active" : ""}`}
            aria-current={t.id === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "mine" && <DashboardList scope="mine" />}
      {tab === "shared" && <DashboardList scope="shared" />}
      {tab === "panels" && (
        <SavedPanelsPage
          creating={creatingPanel}
          onCreated={() => setCreatingPanel(false)}
        />
      )}
      {creating && (
        <NameDialog
          title="New dashboard"
          submitLabel="Create dashboard"
          noun="dashboard"
          withDescription
          onSubmit={async ({ name, description }) => {
            const made = await create.mutateAsync({ name, description });
            navigate(`/dashboards/${made.id}`);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
};
