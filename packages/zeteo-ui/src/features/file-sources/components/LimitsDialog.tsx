import type { UpdateSource } from "@/features/sources/api/types";
import { parseNumberField } from "@/utils/parseNumberField";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { FileSource } from "../api/types";
import { issueFor } from "@/lib/api";
import { useState } from "react";
import {
  NUMBER_FIELDS,
  useSource,
  useUpdateSource,
  type NumberField,
  type Source,
} from "@/features/sources";
import {
  Button,
  FormGrid,
  Input,
  Modal,
  Spinner,
  Switch,
} from "@kosmeo-ui/react";

type Key = NumberField["key"];
type Limits = Record<Key, string>;

const fieldOf = (key: Key) => NUMBER_FIELDS.find((f) => f.key === key)!;

interface LimitsFormProps {
  current: Source;
  onClose: () => void;
}

const LimitsForm = ({ current, onClose }: LimitsFormProps) => {
  const update = useUpdateSource(current.id);
  const [limits, setLimits] = useState<Limits>(
    Object.fromEntries(
      NUMBER_FIELDS.map((f) => [f.key, String(current[f.key])])
    ) as Limits
  );
  const [exportEnabled, setExportEnabled] = useState(current.export_enabled);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});

  const changes = (): UpdateSource => {
    const body: UpdateSource = {};
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n !== undefined && n !== current[field.key]) body[field.key] = n;
    }
    if (exportEnabled !== current.export_enabled) {
      body.export_enabled = exportEnabled;
    }
    return body;
  };

  const submit = () => {
    const found: Partial<Record<Key, string>> = {};
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n === undefined) found[field.key] = "Enter a number.";
      else if (Number.isNaN(n)) found[field.key] = "Enter a number.";
      else if (n < field.min || n > field.max) {
        found[field.key] = `${field.label} is ${field.min} to ${field.max}.`;
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    update.mutate(changes(), { onSuccess: onClose });
  };

  const input = (key: Key, label?: string) => {
    const field = fieldOf(key);
    return (
      <Input
        label={label ?? field.label}
        value={limits[key]}
        error={errors[key] ?? issueFor(update.error, key)}
        onChange={(e) => {
          setLimits((l) => ({ ...l, [key]: e.target.value }));
          setErrors((x) => ({ ...x, [key]: undefined }));
          if (update.error) update.reset();
        }}
      />
    );
  };

  const unchanged = Object.keys(changes()).length === 0;
  return (
    <Modal
      show
      size="lg"
      title="Limits"
      onClose={onClose}
      dismissible={!update.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={update.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="save"
          fullWidth={false}
          isLoading={update.isPending}
          disabled={update.isPending || unchanged}
          onClick={submit}
        >
          Save limits
        </Button>,
      ]}
    >
      <div className="z-fs-dialog">
        <FormGrid columns={3}>
          {input("timeout_ms")}
          {input("row_cap")}
          {input("query_concurrency")}
        </FormGrid>
        <Switch
          size="sm"
          label="Allow exports"
          checked={exportEnabled}
          onChange={(e) => setExportEnabled(e.target.checked)}
        />
        {exportEnabled ? (
          <FormGrid columns={2}>
            {input("export_row_cap", "Export row cap")}
            {input("export_concurrency")}
          </FormGrid>
        ) : (
          <p className="z-note">People can't export from this source.</p>
        )}
        <ErrorNotice
          error={update.error}
          fieldPaths={NUMBER_FIELDS.map((f) => f.key)}
        />
      </div>
    </Modal>
  );
};

/**
 * An admin's change of a file source's limits (`zeteo.sources.write`): the
 * same limits as a database source's, sent to `PATCH /v1/sources/:id`, which
 * takes only these fields for a file source.
 */
export const LimitsDialog = ({
  source,
  onClose,
}: {
  source: FileSource;
  onClose: () => void;
}) => {
  const { data, error, isLoading } = useSource(source.id);
  if (data) return <LimitsForm current={data} onClose={onClose} />;
  return (
    <Modal show title="Limits" onClose={onClose}>
      {isLoading ? <Spinner size="md" /> : <ErrorNotice error={error} />}
    </Modal>
  );
};
