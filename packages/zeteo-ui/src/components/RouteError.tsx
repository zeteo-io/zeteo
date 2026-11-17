import { Button, EmptyState } from "@kosmeo-ui/react";
import { PageHeader } from "./PageHeader";

/** Shown when a page throws or its code fails to load; says nothing of the error itself. */
export const RouteError = () => (
  <main style={{ padding: "1rem 1.5rem" }}>
    <PageHeader title="Something went wrong" />
    <EmptyState
      layout="block"
      action={
        <Button fullWidth={false} onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      The page could not be loaded. Reloading usually fixes it.
    </EmptyState>
  </main>
);
