import { BorderedSection, Button, Spinner } from "@kosmeo-ui/react";
import type { SavedQuery } from "@/features/saved-queries";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { SavedQueryCard } from "./SavedQueryCard";
import { CatalogPanel } from "./CatalogPanel";
import type { ApiError } from "@/lib/api";
import { RunsPanel } from "./RunsPanel";
import { useState } from "react";
import "./styles.css";
import {
  SaveQueryDialog,
  useMySavedQueries,
  useSharedSavedQueries,
} from "@/features/saved-queries";

interface ListState {
  items: SavedQuery[];
  isLoading: boolean;
  error: ApiError | null;
  hasMore: boolean;
  loadMore: () => void;
}

const SavedQueryList = ({
  state,
  kind,
  empty,
}: {
  state: ListState;
  kind: "mine" | "shared";
  empty: string;
}) => (
  <>
    {state.isLoading && <Spinner size="sm" />}
    <ErrorNotice error={state.error} />
    {!state.isLoading && !state.error && state.items.length === 0 && (
      <p className="z-muted">{empty}</p>
    )}
    <div className="z-sq-grid">
      {state.items.map((sq) => (
        <SavedQueryCard key={sq.id} savedQuery={sq} kind={kind} />
      ))}
    </div>
    {state.hasMore && (
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={state.loadMore}
      >
        Load more
      </Button>
    )}
  </>
);

export const MyPage = () => {
  const mine = useMySavedQueries();
  const shared = useSharedSavedQueries();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="My Zeteo" divider={false} />
      <div className="z-my-page">
        <BorderedSection
          title="My saved queries"
          as="h2"
          actions={
            <Button
              size="sm"
              fullWidth={false}
              onClick={() => setCreating(true)}
            >
              New saved query
            </Button>
          }
        >
          <SavedQueryList
            state={mine}
            kind="mine"
            empty="You have no saved queries yet. Save one from a recent run below."
          />
        </BorderedSection>
        <BorderedSection title="Shared with me" as="h2">
          <SavedQueryList
            state={shared}
            kind="shared"
            empty="Nothing has been shared with you."
          />
        </BorderedSection>
        <CatalogPanel />
        <RunsPanel />
      </div>
      {creating && <SaveQueryDialog onClose={() => setCreating(false)} />}
    </>
  );
};
