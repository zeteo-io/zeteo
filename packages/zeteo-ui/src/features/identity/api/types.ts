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

/** The OpenAPI `IdentityValue`: what a person's key stands for in rules. */
export interface IdentityValue {
  id: string;
  key_id: string;
  user_id: string;
  value: string;
  created_by: string;
  created_at: string;
}

/** `GET /v1/identity-keys/:id/missing`: a granted person holding no value. */
export interface MissingUser {
  user_id: string;
  via_grant_ids: string[];
}
