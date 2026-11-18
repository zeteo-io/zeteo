import { useAllSources } from "../api/useAllSources";
import { PageHeader } from "@/components/PageHeader";
import { useNavigate } from "react-router-dom";
import { SOURCES_BACK } from "./sourceBack";
import { SourcesList } from "./SourcesList";
import { Button } from "@kosmeo-ui/react";
import { useAuth } from "@tereo-io/react";

/** Admin: every source, of every kind and owner. */
export const SourcesPage = () => {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const { sources, isLoading, error } = useAllSources(true);
  return (
    <>
      <PageHeader title="Sources" divider={false} />
      <SourcesList
        sources={sources}
        isLoading={isLoading}
        error={error}
        back={SOURCES_BACK}
        allKinds
        emptyText="No sources yet. Add one to let people query its tables."
        actions={
          hasPermission("zeteo.sources.write") && (
            <Button
              size="sm"
              fullWidth={false}
              onClick={() => navigate("/sources/new")}
            >
              New source
            </Button>
          )
        }
      />
    </>
  );
};
