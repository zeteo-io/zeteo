import { fromPage, useSourceBack } from "./sourceBack";
import { PageHeader } from "@/components/PageHeader";
import { Link, NavLink } from "react-router-dom";
import "@/features/tables/components/styles.css";
import type { ReactNode } from "react";
import "./styles.css";

export interface SourceTab {
  /** Relative to the source's own address; "" for its overview. */
  to: string;
  label: string;
}

interface SourceFrameProps {
  /** The source's own address: `/sources/<id>`. */
  baseHref: string;
  name: string;
  description?: string;
  slug: string;
  /** What kind of source: "PostgreSQL", "Upload"… */
  kind: string;
  /** After the kind: the status, or that it is deleted. */
  status?: ReactNode;
  actions?: ReactNode;
  /** Under the header: what an action reported. */
  notices?: ReactNode;
  tabs: SourceTab[];
  children: ReactNode;
}

/** A source's header and tabs, the same for every type of source. */
export const SourceFrame = ({
  baseHref,
  name,
  description,
  slug,
  kind,
  status,
  actions,
  notices,
  tabs,
  children,
}: SourceFrameProps) => {
  const back = useSourceBack();
  return (
    <>
      <Link className="z-muted-link z-back-link" to={back.href}>
        ← {back.label}
      </Link>
      <div className="z-source-header">
        <PageHeader
          title={name}
          badges={
            <span className="z-source-subtitle">
              <code>{slug}</code>
              <span>{kind}</span>
              {status}
            </span>
          }
          actions={actions}
          divider={false}
        />
        {description && <p className="z-source-description">{description}</p>}
      </div>
      {notices}
      <nav className="z-source-tabs" aria-label="Source">
        {tabs.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to ? `${baseHref}/${tab.to}` : baseHref}
            end={tab.to === ""}
            // Keeps where the person came from on every tab, a reload included.
            state={fromPage(back)}
            className="z-source-tab"
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {children}
    </>
  );
};
