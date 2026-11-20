// The OpenAPI `IdentityKey`. A caller with only `zeteo.uploads.write` gets the
// three descriptive fields, so the rest are optional.

export interface IdentityKey {
  id?: string;
  /** What a rule names: `{ identity: "<name>" }`. */
  name: string;
  /** How a rule builder words it: "is one of my <label>". */
  label: string;
  description: string | null;
  value_count?: number;
  created_at?: string;
  updated_at?: string;
}
