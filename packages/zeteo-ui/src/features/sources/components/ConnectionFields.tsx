import { FormGrid, Input, SearchSelect, TextArea } from "@kosmeo-ui/react";
import type { DatabaseType } from "../api/types";
import { tlsName } from "./sourceLabels";

export interface ConnectionState {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  tls: string;
  ca: string;
}

export const DEFAULT_PORT: Record<DatabaseType, string> = {
  postgres: "5432",
  "azure-sql": "1433",
};

export const TLS_MODES: Record<DatabaseType, string[]> = {
  postgres: ["verify", "require", "off"],
  "azure-sql": ["verify", "trust-server-certificate"],
};

export const emptyConnection = (type: DatabaseType): ConnectionState => ({
  host: "",
  port: DEFAULT_PORT[type],
  database: "",
  user: "",
  password: "",
  tls: "verify",
  ca: "",
});

interface ConnectionFieldsProps {
  type: DatabaseType;
  value: ConnectionState;
  onChange: (patch: Partial<ConnectionState>) => void;
  /** The message for a field, by its API path (`settings.host`). */
  errorFor: (path: string) => string | undefined;
  /** Editing a stored source: its password and CA are never shown. */
  editing?: boolean;
}

const FieldError = ({ message }: { message?: string }) =>
  message ? (
    <div className="z-source-field-error" role="alert">
      {message}
    </div>
  ) : null;

// Controlled: kosmeo's Input and TextArea show whatever `value` they are given.
export const ConnectionFields = ({
  type,
  value,
  onChange,
  errorFor,
  editing = false,
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
      helperText={
        editing
          ? "The stored password is not shown. Enter it again."
          : undefined
      }
      onChange={(e) => onChange({ password: e.target.value })}
    />
    <div>
      <SearchSelect<string>
        label="TLS"
        value={value.tls}
        options={TLS_MODES[type]}
        getOptionLabel={tlsName}
        getOptionKey={(mode) => mode}
        onSelect={(tls) => onChange({ tls })}
      />
      <FieldError message={errorFor("settings.tls")} />
    </div>
    {type === "postgres" && value.tls === "verify" && (
      <div className="z-source-ca">
        <TextArea
          label="CA certificate (optional)"
          rows={4}
          value={value.ca}
          onChange={(e) => onChange({ ca: e.target.value })}
        />
        {editing && (
          <div className="z-source-field-note">
            The stored CA is not shown. Paste it again; leaving this empty
            removes it.
          </div>
        )}
        <FieldError message={errorFor("settings.ca")} />
      </div>
    )}
  </FormGrid>
);
