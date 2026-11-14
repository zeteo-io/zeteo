import { FormGrid, Input, Select, TextArea } from "@kosmeo-ui/react";
import type { SourceType } from "../api/types";

export interface ConnectionState {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  tls: string;
  ca: string;
}

export const DEFAULT_PORT: Record<SourceType, string> = {
  postgres: "5432",
  "azure-sql": "1433",
};

export const TLS_MODES: Record<SourceType, string[]> = {
  postgres: ["verify", "require", "off"],
  "azure-sql": ["verify", "trust-server-certificate"],
};

export const emptyConnection = (type: SourceType): ConnectionState => ({
  host: "",
  port: DEFAULT_PORT[type],
  database: "",
  user: "",
  password: "",
  tls: "verify",
  ca: "",
});

interface ConnectionFieldsProps {
  type: SourceType;
  value: ConnectionState;
  onChange: (patch: Partial<ConnectionState>) => void;
  /** The message for a field, by its API path (`settings.host`). */
  errorFor: (path: string) => string | undefined;
}

// Controlled: kosmeo's Input and TextArea show whatever `value` they are given.
export const ConnectionFields = ({
  type,
  value,
  onChange,
  errorFor,
}: ConnectionFieldsProps) => (
  <FormGrid columns={2}>
    <Input
      label="Host"
      required
      value={value.host}
      error={errorFor("settings.host")}
      onChange={(e) => onChange({ host: e.target.value })}
    />
    <Input
      label="Port"
      type="number"
      min={1}
      max={65535}
      value={value.port}
      error={errorFor("settings.port")}
      onChange={(e) => onChange({ port: e.target.value })}
    />
    <Input
      label="Database"
      required
      value={value.database}
      error={errorFor("settings.database")}
      onChange={(e) => onChange({ database: e.target.value })}
    />
    <Input
      label="User"
      required
      value={value.user}
      error={errorFor("settings.user")}
      onChange={(e) => onChange({ user: e.target.value })}
    />
    <Input
      label="Password"
      type="password"
      required
      autoComplete="new-password"
      value={value.password}
      error={errorFor("settings.password")}
      onChange={(e) => onChange({ password: e.target.value })}
    />
    <Select
      label="TLS"
      value={value.tls}
      options={TLS_MODES[type].map((mode) => ({ value: mode, label: mode }))}
      onChange={(tls) => onChange({ tls: tls ?? "verify" })}
    />
    {type === "postgres" && (
      <TextArea
        label="CA certificate"
        rows={4}
        value={value.ca}
        onChange={(e) => onChange({ ca: e.target.value })}
      />
    )}
  </FormGrid>
);
