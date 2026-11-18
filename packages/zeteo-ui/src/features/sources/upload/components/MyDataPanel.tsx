import { useDeleteUploadSource, useMyUploads } from "../api/uploads";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { SourcesList } from "../../components/SourcesList";
import { MY_DATA_BACK } from "../../components/sourceBack";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useNavigate } from "react-router-dom";
import type { Source } from "../../api/types";
import { Button } from "@kosmeo-ui/react";
import { ADD_DATA_HREF } from "./labels";
import "./styles.css";

const DeleteSource = ({ source }: { source: Source }) => {
  const remove = useDeleteUploadSource();
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Delete"
      confirmTitle="Delete source"
      confirmText={`Delete "${source.name}" and all its data? Zeteo holds the only copy, so it cannot be recovered. Saved queries and dashboards using it stop working.`}
      confirmLabel="Delete source"
      onConfirm={() => remove.mutateAsync(source.id)}
    />
  );
};

/**
 * My Zeteo's "My sources": the Sources list of the person's own upload
 * sources (`owner_id=me&type=upload`). Kind and owner go without saying;
 * an upload is active until deleted and never refreshed.
 */
export const MyDataPanel = () => {
  const navigate = useNavigate();
  const { data, error, isLoading } = useMyUploads();
  return (
    <SourcesList
      sources={data ?? []}
      isLoading={isLoading}
      error={error}
      back={MY_DATA_BACK}
      hide={["kind", "owner", "status", "refreshed"]}
      emptyText="Upload a CSV or Excel file, or add a Google Sheet, to query it and share it."
      actions={
        <Button
          size="sm"
          fullWidth={false}
          onClick={() => navigate(ADD_DATA_HREF)}
        >
          Add data
        </Button>
      }
      rowActions={(source) => <DeleteSource source={source} />}
    />
  );
};
