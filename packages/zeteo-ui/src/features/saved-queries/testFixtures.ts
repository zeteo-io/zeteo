import type { SavedQuery, Share } from "./api/types";

export const SAVED_ID = "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const OWNER_ID = "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const PERSON_ID = "e1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";

export const makeSavedQuery = (over: Partial<SavedQuery> = {}): SavedQuery => ({
  id: SAVED_ID,
  name: "Weekly revenue",
  description: "Paid orders per week",
  owner: { id: OWNER_ID, name: "Olive Owner" },
  accessible: true,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-02T10:00:00.000Z",
  last_run_at: null,
  you_last_ran_at: null,
  source: { id: "5f0c8f0e-1c7a-4a53-9d0e-6a3b1f2c4d55", slug: "sales-db" },
  query: { source: "sales-db", from: "orders", limit: 10 },
  ...over,
});

export const makeShare = (over: Partial<Share> = {}): Share => ({
  type: "user",
  id: PERSON_ID,
  name: "Pat Person",
  email: "pat@example.com",
  shared_at: "2026-11-03T10:00:00.000Z",
  ...over,
});
