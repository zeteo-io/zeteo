import { ConfirmButton } from "@/components/ConfirmButton";
import { useNavigate, useParams } from "react-router-dom";
import { useDeleteGrant } from "../api/useDeleteGrant";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EmptyState, Spinner } from "@kosmeo-ui/react";
import { PageHeader } from "@/components/PageHeader";
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
  const { grantId = "" } = useParams();
  const navigate = useNavigate();
  const { data: grant, isLoading, error } = useGrant(grantId);
  const del = useDeleteGrant();

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
          <ConfirmButton
            danger
            label="Delete grant"
            confirmTitle="Delete this grant?"
            confirmText="The principal can no longer query this table through this grant."
            confirmLabel="Remove grant"
            onConfirm={() =>
              del.mutateAsync(grant.id).then(() => navigate("/grants"))
            }
          />
        }
      />
      <GrantForm grant={grant} />
    </>
  );
};
