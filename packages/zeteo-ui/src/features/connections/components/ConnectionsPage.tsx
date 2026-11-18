import { BorderedSection, Button, Spinner } from "@kosmeo-ui/react";
import { Facts, When } from "@/features/sources/components/Facts";
import { useGoogleConnection } from "../api/useGoogleConnection";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalLabel } from "@/features/principals";
import { PageHeader } from "@/components/PageHeader";
import { GoogleKeyDialog } from "./GoogleKeyDialog";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";
import "./styles.css";

/** Admin: the connections Zeteo reads data through. Today, one Google service account. */
export const ConnectionsPage = () => {
  const { hasPermission } = useAuth();
  const { data, error, isLoading } = useGoogleConnection();
  const [editing, setEditing] = useState(false);
  const canSet = hasPermission("zeteo.sources.write");

  return (
    <>
      <PageHeader title="Connections" divider={false} />
      <div className="z-connections">
        <BorderedSection
          title="Google"
          as="h2"
          actions={
            canSet && !isLoading && !error ? (
              <Button
                size="sm"
                variant={data ? "secondary" : undefined}
                fullWidth={false}
                onClick={() => setEditing(true)}
              >
                Set key
              </Button>
            ) : undefined
          }
        >
          {isLoading ? (
            <Spinner size="md" />
          ) : error ? (
            <ErrorNotice error={error} />
          ) : data ? (
            <Facts
              rows={[
                ["Service account", data.service_account_email],
                ["Updated", <When iso={data.updated_at} />],
                [
                  "Updated by",
                  <PrincipalLabel
                    refValue={{ type: "user", id: data.updated_by }}
                  />,
                ],
              ]}
            />
          ) : (
            <p className="z-muted">Not set up</p>
          )}
          <p className="z-note">
            Google Sheets sources read their spreadsheets as this service
            account: people share a sheet with its email address as a Viewer.
          </p>
        </BorderedSection>
      </div>
      {editing && <GoogleKeyDialog onClose={() => setEditing(false)} />}
    </>
  );
};
