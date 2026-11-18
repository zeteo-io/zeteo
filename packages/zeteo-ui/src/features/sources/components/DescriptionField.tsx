import { TextArea } from "@kosmeo-ui/react";

export const MAX_DESCRIPTION = 500;

/** The problem with a source description, or undefined when it is fine. */
export const descriptionProblem = (value: string) =>
  value.trim().length > MAX_DESCRIPTION
    ? `A description is at most ${MAX_DESCRIPTION} characters.`
    : undefined;

/** The description field of a source form: what the source holds, with its note or error. */
export const DescriptionField = ({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) => (
  <div>
    <TextArea
      label="Description"
      rows={3}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
    {error ? (
      <p className="z-source-field-error" role="alert">
        {error}
      </p>
    ) : (
      <p className="z-muted z-source-field-note">
        What this source holds. Shown to people and to Claude.
      </p>
    )}
  </div>
);
