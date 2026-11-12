import type { Prisma } from "./db/prisma.js";

// The statement @tereo-io/sdk's outbox writes one row with, `$1` to `$5` in
// this column order. Anything else fails loudly rather than being dropped.
const SDK_INSERT =
  /^INSERT INTO "core"\."core_outbox" \("id", "destination", "payload", "traceparent", "tracestate"\)\s+VALUES \(\$1::uuid, \$2, \$3::jsonb, \$4, \$5\)$/;

type Row = [string, string, string, string | null, string | null];

/**
 * A stand-in transaction for the SDK's `outbox.emit` and `outbox.audit`: they
 * validate and build their rows as usual, and `flush` writes every row they
 * gave it in one statement, in the order given.
 */
export const collector = () => {
  const rows: Row[] = [];
  const client = {
    $executeRawUnsafe: (query: string, ...values: unknown[]) => {
      if (!SDK_INSERT.test(query.trim()) || values.length !== 5) {
        throw new Error(`Unexpected outbox statement: ${query}`);
      }
      rows.push(values as Row);
      return Promise.resolve(1);
    },
    $queryRawUnsafe: (query: string): Promise<never> =>
      Promise.reject(new Error(`Unexpected outbox query: ${query}`)),
  };
  const flush = async (tx: Prisma.TransactionClient): Promise<void> => {
    if (rows.length === 0) return;
    const column = (i: number) => rows.map((row) => row[i]);
    await tx.$executeRaw`
      INSERT INTO "core"."core_outbox"
        ("id", "destination", "payload", "traceparent", "tracestate")
      SELECT t.id::uuid, t.destination, t.payload::jsonb, t.traceparent, t.tracestate
      FROM unnest(${column(0)}::text[], ${column(1)}::text[], ${column(2)}::text[],
                  ${column(3)}::text[], ${column(4)}::text[])
        WITH ORDINALITY AS t(id, destination, payload, traceparent, tracestate, n)
      ORDER BY t.n`;
    rows.length = 0;
  };
  return { client, flush };
};
