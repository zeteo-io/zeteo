import { SectionHeader } from "@kosmeo-ui/react";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badges?: ReactNode;
  actions?: ReactNode;
}

export const PageHeader = ({
  title,
  subtitle,
  badges,
  actions,
}: PageHeaderProps) => (
  <SectionHeader
    as="h1"
    title={title}
    subtitle={subtitle}
    badges={badges}
    actions={actions}
  />
);
