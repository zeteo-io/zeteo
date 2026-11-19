import { isUploadType, sourceTypeName, tlsName } from "./sourceLabels";
import { UploadOverview } from "../upload/components/UploadPages";
import { Facts, LimitSections, When, type Row } from "./Facts";
import { Alert, BorderedSection } from "@kosmeo-ui/react";
import { formatBytes } from "@/utils/formatBytes";
import { useSourceContext } from "./context";
import "./styles.css";

/** A source's overview: an upload's data, or a database source's catalogue and connection. */
export const SourceDetailPage = () => {
  const { source } = useSourceContext();
  return isUploadType(source.type) ? <UploadOverview /> : <DatabaseOverview />;
};

const DatabaseOverview = () => {
  const { source } = useSourceContext();
  const settings = source.settings;

  const catalogueRows: Row[] = [
    [
      "Schemas",
      <span className="z-source-chips">
        {source.schemas.map((s) => (
          <span key={s} className="z-source-chip">
            {s}
          </span>
        ))}
      </span>,
    ],
    ["Last refreshed", <When iso={source.last_refreshed_at} />],
    [
      "Size",
      typeof source.size_bytes !== "number" ? (
        <span className="z-muted">Unknown</span>
      ) : (
        formatBytes(source.size_bytes)
      ),
    ],
    ["Added", <When iso={source.created_at} />],
  ];
  if (source.archived_at) {
    catalogueRows.push(["Archived", <When iso={source.archived_at} />]);
  }

  return (
    <div className="z-source-overview">
      <div className="z-source-column">
        <LimitSections source={source} />
        <BorderedSection title="Catalogue" as="h2">
          <Facts rows={catalogueRows} />
        </BorderedSection>
      </div>
      <div className="z-source-column">
        <BorderedSection title="Connection" as="h2">
          {settings === null ? (
            <Alert variant="warning">
              The stored connection settings are unreadable. Change the
              connection to replace them.
            </Alert>
          ) : (
            <Facts
              rows={[
                ["Database type", sourceTypeName(source.type)],
                ["Host", String(settings.host ?? "—")],
                ["Port", String(settings.port ?? "Default")],
                ["Database", String(settings.database ?? "—")],
                ["User", String(settings.user ?? "—")],
                ["TLS", tlsName(settings.tls)],
                [
                  "Writable login",
                  source.writable_login_allowed ? "Allowed" : "Not allowed",
                ],
              ]}
            />
          )}
        </BorderedSection>
      </div>
    </div>
  );
};
