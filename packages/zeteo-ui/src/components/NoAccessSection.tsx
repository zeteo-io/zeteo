import { EmptyState } from "@kosmeo-ui/react";
import { PageHeader } from "./PageHeader";

/** In-layout "no access": the navigation stays visible around it. */
export const NoAccessSection = ({ permission }: { permission: string }) => (
  <>
    <PageHeader title="No access" />
    <EmptyState layout="block">
      You need the <code>{permission}</code> permission to see this page. Ask an
      administrator for it.
    </EmptyState>
  </>
);
