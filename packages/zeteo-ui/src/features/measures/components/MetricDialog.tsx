import { usePreviewMetric } from "../api/usePreviewMetric";
import type { Metric, MetricInput } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useSaveMetric } from "../api/useSaveMetric";
import { useState, type ReactNode } from "react";
import { PreviewResult } from "./PreviewResult";
import type { ApiError } from "@/lib/api";
import "./styles.css";
import {
  BorderedSection,
  Button,
  Form,
  Input,
  Modal,
  TextArea,
} from "@kosmeo-ui/react";
import {
  fieldErrors,
  previewFieldErrors,
  type MeasureField,
} from "./fieldErrors";

const FORM_ID = "metric-form";
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

type Field = "name" | "description" | "formula";

const pretty = (value: unknown) =>
  value === null || value === undefined ? "" : JSON.stringify(value, null, 2);

const Slot = ({
  name,
  error,
  children,
}: {
  name: MeasureField;
  error?: string | undefined;
  children: ReactNode;
}) => (
  <div data-field={name}>
    {children}
    {error && (
      <p className="z-measure-field-error" role="alert">
        {error}
      </p>
    )}
  </div>
);

/** The first day of the month twelve months before `now`, as a date. */
export const twelveMonthsBack = (now = new Date()): string => {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 12, 1));
  return d.toISOString().slice(0, 10);
};

interface MetricDialogProps {
  sourceId: string;
  /** The metric to change; absent to create one. */
  metric?: Metric;
  onClose: () => void;
}

/** Creating or changing a metric: its formula as JSON over measures, checked by the server, and a monthly preview of the last 12 months. */
export const MetricDialog = ({
  sourceId,
  metric,
  onClose,
}: MetricDialogProps) => {
  const save = useSaveMetric(sourceId);
  const preview = usePreviewMetric(sourceId);
  const [name, setNameText] = useState(metric?.name ?? "");
  const [description, setDescriptionText] = useState(metric?.description ?? "");
  const [formula, setFormulaText] = useState(pretty(metric?.formula));
  const [local, setLocal] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  // A preview is of the draft it ran; any change to the draft clears it.
  const changing =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      preview.reset();
      set(value);
    };
  const setName = changing(setNameText);
  const setDescription = changing(setDescriptionText);
  const setFormula = changing(setFormulaText);
  const busy = save.isPending;

  const draft = ():
    { input: MetricInput } | { problems: Partial<Record<Field, string>> } => {
    const problems: Partial<Record<Field, string>> = {};
    if (!NAME.test(name)) {
      problems.name =
        "Use lower case letters, digits and underscores, starting with a letter (1 to 63 characters).";
    }
    if (!description.trim())
      problems.description = "Say what the metric means.";
    let parsed: unknown;
    try {
      parsed = JSON.parse(formula);
    } catch {
      problems.formula = "The formula is not valid JSON.";
    }
    if (Object.keys(problems).length > 0) return { problems };
    return {
      input: { name, description: description.trim(), formula: parsed },
    };
  };

  const submit = () => {
    const d = draft();
    setFailure(null);
    if ("problems" in d) {
      setLocal(d.problems);
      return;
    }
    setLocal({});
    const input = d.input;
    if (!metric) {
      save.mutate({ body: input }, { onSuccess: onClose, onError: setFailure });
      return;
    }
    const body: Partial<MetricInput> = {};
    if (input.name !== metric.name) body.name = input.name;
    if (input.description !== metric.description)
      body.description = input.description;
    if (JSON.stringify(input.formula) !== JSON.stringify(metric.formula))
      body.formula = input.formula;
    if (Object.keys(body).length === 0) return onClose();
    save.mutate(
      { id: metric.id, body },
      { onSuccess: onClose, onError: setFailure }
    );
  };

  const runPreview = () => {
    const d = draft();
    if ("problems" in d) {
      setLocal(d.problems);
      return;
    }
    setLocal({});
    preview.mutate({
      metric: d.input,
      bucket: "month",
      range: { gte: { date: twelveMonthsBack() } },
    });
  };

  const server = fieldErrors(failure);
  const previewed = previewFieldErrors(preview.error, "metric");
  const err = (f: Field) => local[f] ?? server[f] ?? previewed[f];
  const used = metric?.used_by;
  const renaming =
    !!metric &&
    name !== metric.name &&
    !!used &&
    (used.saved_queries > 0 || used.panels > 0);

  return (
    <Modal
      show
      title={metric ? "Edit metric" : "New metric"}
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
          key="preview"
          variant="secondary"
          fullWidth={false}
          isLoading={preview.isPending}
          disabled={busy || preview.isPending}
          onClick={runPreview}
        >
          Preview
        </Button>,
        <Button
          key="save"
          type="submit"
          form={FORM_ID}
          fullWidth={false}
          isLoading={busy}
          disabled={busy}
        >
          Save
        </Button>,
      ]}
    >
      <div className="z-measure-form">
        <Form id={FORM_ID} onSubmit={submit}>
          <Slot name="name" error={err("name")}>
            <Input
              label="Name"
              required
              value={name}
              helperText="Unique in the source among measures and metrics; queries ask for it in { metrics: [name] }."
              onChange={(e) => setName(e.target.value)}
            />
            {renaming && used && (
              <p className="z-muted" role="status">
                {metric.name} is used by {used.saved_queries}{" "}
                {used.saved_queries === 1 ? "saved query" : "saved queries"} and{" "}
                {used.panels} {used.panels === 1 ? "panel" : "panels"}; they
                will stop working under the new name.
              </p>
            )}
          </Slot>
          <Slot name="description" error={err("description")}>
            <TextArea
              label="Description"
              required
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Slot>
          <Slot name="formula" error={err("formula")}>
            <div className="z-measure-json">
              <TextArea
                label="Formula (JSON)"
                required
                rows={6}
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
              />
            </div>
          </Slot>
          {(preview.data ||
            (preview.error && Object.keys(previewed).length === 0)) && (
            <BorderedSection title="Preview: by month, last 12 months" as="h3">
              {preview.data && <PreviewResult result={preview.data} />}
              <ErrorNotice error={preview.error} />
            </BorderedSection>
          )}
          {Object.keys(server).length === 0 && <ErrorNotice error={failure} />}
        </Form>
      </div>
    </Modal>
  );
};
