import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@kosmeo-ui/react";

export const NotFound = () => (
  <>
    <PageHeader title="Page not found" />
    <EmptyState layout="block">There is nothing at this address.</EmptyState>
  </>
);
