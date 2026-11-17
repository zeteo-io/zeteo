import { SectionHeader } from "@kosmeo-ui/react";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  /** The line under the header; leave it off when tabs follow, which draw their own. */
  divider?: boolean;
}

export const PageHeader = ({
  title,
  subtitle,
  badges,
  actions,
  divider,
}: PageHeaderProps) => (
  <SectionHeader
    as="h1"
    title={title}
    subtitle={subtitle}
    badges={badges}
    actions={actions}
    divider={divider}
  />
);
