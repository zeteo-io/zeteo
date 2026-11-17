import type { Dashboard, DashboardTheme, TimeRangeKey } from "../api/types";
import { useSaveDashboard } from "../api/useSaveDashboard";
import { ErrorNotice } from "@/components/ErrorNotice";
import { toApiError, type ApiError } from "@/lib/api";
import { TimeRangePicker } from "./TimeRangePicker";
import { useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  SearchSelect,
  TextArea,
} from "@kosmeo-ui/react";

const Failure = ({ error, noun }: { error: ApiError | null; noun: string }) =>
  error?.status === 409 ? (
    <Alert variant="warning">You already have a {noun} with this name.</Alert>
  ) : (
    <ErrorNotice error={error} />
  );

const FormModal = ({
  title,
  submitLabel,
  busy,
  disabled,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) => (
  <Modal
    show
    title={title}
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
        key="submit"
        fullWidth={false}
        isLoading={busy}
        disabled={busy || disabled}
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>,
    ]}
  >
    <div className="z-my-form">{children}</div>
  </Modal>
);

interface NameDialogProps {
  title: string;
  submitLabel: string;
  /** What a name clash is about: "dashboard", "saved panel". */
  noun: string;
  initialName?: string;
  /** Ask for a description too. */
  withDescription?: boolean;
  onSubmit: (value: { name: string; description: string }) => Promise<unknown>;
  onClose: () => void;
}

/** A name (and a description): new, copy and "Save as saved panel". */
export const NameDialog = ({
  title,
  submitLabel,
  noun,
  initialName = "",
  withDescription = false,
  onSubmit,
  onClose,
}: NameDialogProps) => {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), description });
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };
  return (
    <FormModal
      title={title}
      submitLabel={submitLabel}
      busy={busy}
      disabled={name.trim() === ""}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <Input
        label="Name"
        value={name}
        max={100}
        onChange={(e) => setName(e.target.value)}
      />
      {withDescription && (
        <TextArea
          label="Description"
          value={description}
          max={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      )}
      <Failure error={error} noun={noun} />
    </FormModal>
  );
};

interface ThemeOption {
  value: DashboardTheme;
  label: string;
}

const THEMES: ThemeOption[] = [
  { value: "auto", label: "Follow the screen" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A dashboard's name, description, default time range, auto-refresh and display theme. */
export const DashboardDetailsDialog = ({
  dashboard,
  onClose,
}: {
  dashboard: Dashboard;
  onClose: () => void;
}) => {
  const save = useSaveDashboard(dashboard.id);
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description);
  const [timeRange, setTimeRange] = useState<TimeRangeKey | null>(
    dashboard.time_range
  );
  const [refresh, setRefresh] = useState(
    dashboard.refresh_seconds === null ? "" : String(dashboard.refresh_seconds)
  );
  const [theme, setTheme] = useState<DashboardTheme>(dashboard.theme);
  const seconds = refresh.trim() === "" ? null : Number(refresh);
  const badRefresh = seconds !== null && !Number.isInteger(seconds);

  const submit = () =>
    save.mutate(
      {
        name: name.trim(),
        description,
        time_range: timeRange,
        refresh_seconds: seconds,
        theme,
      },
      { onSuccess: onClose }
    );

  return (
    <FormModal
      title="Edit details"
      submitLabel="Save"
      busy={save.isPending}
      disabled={name.trim() === "" || badRefresh}
      onSubmit={submit}
      onClose={onClose}
    >
      <Input
        label="Name"
        value={name}
        max={100}
        onChange={(e) => setName(e.target.value)}
      />
      <TextArea
        label="Description"
        value={description}
        max={2000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <TimeRangePicker
        label="Default time range"
        value={timeRange}
        onChange={setTimeRange}
      />
      <Input
        label="Refresh every (seconds, empty for never)"
        type="number"
        min={60}
        value={refresh}
        onChange={(e) => setRefresh(e.target.value)}
      />
      <SearchSelect<ThemeOption>
        label="Display theme"
        value={THEMES.find((t) => t.value === theme)!}
        options={THEMES}
        getOptionLabel={(t) => t.label}
        getOptionKey={(t) => t.value}
        onSelect={(t) => setTheme(t.value)}
      />
      <Failure error={save.error} noun="dashboard" />
    </FormModal>
  );
};
