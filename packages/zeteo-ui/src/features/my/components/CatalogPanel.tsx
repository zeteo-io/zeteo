import { sourceTypeName } from "@/features/sources/components/sourceLabels";
import { BorderedSection, Spinner } from "@kosmeo-ui/react";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { CatalogSource } from "../api/types";
import { useCatalog } from "../api/useCatalog";
import { useState } from "react";

const SourceRow = ({ source }: { source: CatalogSource }) => {
  const [open, setOpen] = useState(false);
  const count = source.tables.length;
  return (
    <li className="z-catalog-source">
      <button
        type="button"
        className="z-catalog-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="z-sq-name">{source.name}</span>
        <span className="z-muted">
          {sourceTypeName(source.type as never)} · {count}{" "}
          {count === 1 ? "table" : "tables"}
        </span>
      </button>
      {open && (
        <ul className="z-catalog-tables">
          {source.tables.map((t) => (
            <li key={`${t.schema_name ?? ""}.${t.name}`}>{t.name}</li>
          ))}
        </ul>
      )}
    </li>
  );
};

export const CatalogPanel = () => {
  const catalog = useCatalog();
  return (
    <BorderedSection title="What I can query" as="h2">
      {catalog.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={catalog.error} />
      {catalog.data?.length === 0 && (
        <p className="z-muted">
          You have no access to any data yet. Ask an admin to grant it.
        </p>
      )}
      {catalog.data && catalog.data.length > 0 && (
        <ul className="z-catalog-list">
          {catalog.data.map((s) => (
            <SourceRow key={s.slug} source={s} />
          ))}
        </ul>
      )}
    </BorderedSection>
  );
};
