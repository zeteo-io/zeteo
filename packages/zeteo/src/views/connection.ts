/** A connection as a caller sees it: who it signs in as, never the key. */
export const connectionView = (row: {
  serviceAccountEmail: string;
  updatedAt: Date;
  updatedBy: string;
}) => ({
  provider: "google" as const,
  service_account_email: row.serviceAccountEmail,
  updated_at: row.updatedAt.toISOString(),
  updated_by: row.updatedBy,
});

export type ConnectionView = ReturnType<typeof connectionView>;
