import { LIMIT_FIELDS, type PrincipalLimit } from "../api/types";
import { Alert, Button, Input, Modal } from "@kosmeo-ui/react";
import { parseNumberField } from "@/utils/parseNumberField";
import { useUpdateLimit } from "../api/useUpdateLimit";
import { useCreateLimit } from "../api/useCreateLimit";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { ApiError } from "@/lib/api";
import { useState } from "react";
import "./styles.css";
import {
  PrincipalLabel,
  PrincipalPicker,
  type PrincipalRef,
} from "@/features/principals";

type Key = (typeof LIMIT_FIELDS)[number]["key"];

interface LimitFormProps {
  /** The row to change; absent to create one. */
  limit?: PrincipalLimit;
  onClose: () => void;
  /** Create found the principal already has a row. */
  onConflict?: (principal: PrincipalRef) => void;
}

const CONFLICT = "A limit already exists for this principal";

export const LimitForm = ({ limit, onClose, onConflict }: LimitFormProps) => {
  const create = useCreateLimit();
  const update = useUpdateLimit();
  const [principal, setPrincipal] = useState<PrincipalRef | null>(null);
  const [values, setValues] = useState<Record<Key, string>>({
    query_concurrency: String(limit?.query_concurrency ?? ""),
    export_concurrency: String(limit?.export_concurrency ?? ""),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const busy = create.isPending || update.isPending;

  const parsed = (key: Key) => parseNumberField(values[key]);

  /** What PATCH would carry: only what differs, `null` for a cleared value. */
  const changes = (row: PrincipalLimit) => {
    const body: Partial<Record<Key, number | null>> = {};
    for (const { key } of LIMIT_FIELDS) {
      const n = parsed(key);
      if (n === undefined) {
        if (row[key] !== null) body[key] = null;
      } else if (n !== row[key]) {
        body[key] = n;
      }
    }
    return body;
  };
  const unchanged =
    limit !== undefined && Object.keys(changes(limit)).length === 0;

  const validate = () => {
    const found: Record<string, string> = {};
    if (!limit && !principal) found.principal = "Choose a user or group.";
    for (const field of LIMIT_FIELDS) {
      const n = parsed(field.key);
      if (n !== undefined && Number.isNaN(n)) {
        found[field.key] = "Enter a number.";
      } else if (n !== undefined && (n < field.min || n > field.max)) {
        found[field.key] = `${field.label} is ${field.min} to ${field.max}.`;
      }
    }
    if (
      Object.keys(found).length === 0 &&
      LIMIT_FIELDS.every((f) => parsed(f.key) === undefined)
    ) {
      found.form = limit
        ? "A limit needs at least one value. Delete the limit instead to remove both."
        : "Set at least one of the two limits.";
    }
    return found;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    const onError = (err: ApiError) => {
      if (!limit && err.status === 409 && principal) {
        setErrors({ form: CONFLICT });
        onConflict?.(principal);
      } else {
        setFailure(err);
      }
    };
    if (limit) {
      update.mutate(
        { id: limit.id, body: changes(limit) },
        { onSuccess: onClose, onError }
      );
      return;
    }
    const body = {
      principal_type: principal!.type,
      principal_id: principal!.id,
      ...Object.fromEntries(
        LIMIT_FIELDS.flatMap(({ key }) => {
          const n = parsed(key);
          return n === undefined ? [] : [[key, n]];
        })
      ),
    };
    create.mutate(body, { onSuccess: onClose, onError });
  };

  const edited = (key: string) =>
    setErrors((prev) => {
      const { [key]: _gone, form: _form, ...rest } = prev;
      return rest;
    });

  return (
    <Modal
      show
      title={limit ? "Change limits" : "New limit"}
      onClose={onClose}
      dismissible={!busy}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="save"
          fullWidth={false}
          isLoading={busy}
          disabled={busy || unchanged}
          onClick={submit}
        >
          {limit ? "Save" : "Create limit"}
        </Button>,
      ]}
    >
      <div className="z-limits-form">
        {limit ? (
          <p>
            <PrincipalLabel
              refValue={{ type: limit.principal_type, id: limit.principal_id }}
            />
          </p>
        ) : (
          <div>
            <PrincipalPicker
              value={principal}
              onChange={(p) => {
                setPrincipal(p);
                edited("principal");
              }}
            />
            {errors.principal && (
              <Alert variant="warning" size="sm">
                {errors.principal}
              </Alert>
            )}
          </div>
        )}
        <div className="z-limits-fields">
          {LIMIT_FIELDS.map((field) => (
            <Input
              key={field.key}
              label={field.label}
              type="number"
              value={values[field.key]}
              error={errors[field.key]}
              helperText={`${field.min}–${field.max}. Empty: the default.`}
              onChange={(e) => {
                setValues((prev) => ({ ...prev, [field.key]: e.target.value }));
                edited(field.key);
              }}
            />
          ))}
        </div>
        {errors.form && <Alert variant="warning">{errors.form}</Alert>}
        <ErrorNotice error={failure} />
      </div>
    </Modal>
  );
};
