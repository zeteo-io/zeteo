import { GrantDeleteButton } from "./GrantDeleteButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EmptyState, Spinner } from "@kosmeo-ui/react";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useNavigate } from "react-router-dom";
import { useGrant } from "../api/useGrant";
import { GrantForm } from "./GrantForm";

export const GrantNewPage = () => (
  <>
    <PageHeader
      title="New grant"
      subtitle="Let a user or group query a table"
    />
    <GrantForm />
  </>
);

export const GrantEditPage = () => {
  const grantId = useUuidParam("grantId");
  return grantId ? <GrantEdit grantId={grantId} /> : <NotFound />;
};

const GrantEdit = ({ grantId }: { grantId: string }) => {
  const navigate = useNavigate();
  const { data: grant, isLoading, error } = useGrant(grantId);

  if (isLoading) return <Spinner size="lg" />;
  if (error?.status === 404) {
    return (
      <>
        <PageHeader title="Grant not found" />
        <EmptyState layout="block">
          There is no such grant. It may have been removed.
        </EmptyState>
      </>
    );
  }
  if (!grant) {
    return (
      <>
        <PageHeader title="Edit grant" />
        <ErrorNotice error={error} />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Edit grant"
        actions={
          <GrantDeleteButton
            grant={grant}
            label="Delete grant"
            confirmLabel="Remove grant"
            onDeleted={() => navigate("/grants")}
          />
        }
      />
      <GrantForm grant={grant} />
    </>
  );
};
