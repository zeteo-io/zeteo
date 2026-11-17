import { CUSTOMERS_ID, ORDERS_ID } from "@/features/tables/testFixtures";
import type { Relation } from "./api/types";

export const makeRelation = (over: Partial<Relation> = {}): Relation => ({
  id: "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "customer",
  from_table_id: ORDERS_ID,
  from_columns: ["customer_id"],
  to_table_id: CUSTOMERS_ID,
  to_columns: ["id"],
  to_many: false,
  origin: "declared",
  missing_since: null,
  ...over,
});
