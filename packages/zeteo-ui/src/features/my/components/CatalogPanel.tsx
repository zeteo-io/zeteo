import { sourceTypeName } from "@/features/sources/components/sourceLabels";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { CatalogSource } from "../api/types";
import { useCatalog } from "../api/useCatalog";
import { Spinner } from "@kosmeo-ui/react";
import { useState } from "react";
import {
  faChevronDown,
  faChevronRight,
} from "@fortawesome/free-solid-svg-icons";

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
        <FontAwesomeIcon
          className="z-catalog-chevron"
          icon={open ? faChevronDown : faChevronRight}
          aria-hidden
        />
        <span className="z-catalog-name">{source.name}</span>
        <span className="z-catalog-count">
          {sourceTypeName(source.type)} · {count}{" "}
          {count === 1 ? "table" : "tables"}
        </span>
      </button>
      {open && (
        <ul className="z-catalog-tables">
          {source.tables.map((t) => (
            <li key={`${t.schema_name ?? ""}.${t.name}`}>
              <code>{t.name}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

export const CatalogList = () => {
  const catalog = useCatalog();
  return (
    <>
      {catalog.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={catalog.error} />
      {catalog.data?.length === 0 && (
        <p className="z-note">
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
    </>
  );
};
