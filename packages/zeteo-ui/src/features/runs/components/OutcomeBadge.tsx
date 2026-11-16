import type { RunOutcome } from "../api/types";
import { Badge } from "@kosmeo-ui/react";

const VARIANT = {
  ok: "success",
  refused: "warning",
  failed: "danger",
  timeout: "danger",
  running: "secondary",
} as const;

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  ok: "OK",
  refused: "Refused",
  failed: "Failed",
  timeout: "Timed out",
  running: "Running",
};

export const OutcomeBadge = ({ outcome }: { outcome: RunOutcome }) => (
  <Badge variant={VARIANT[outcome]} size="sm">
    {OUTCOME_LABEL[outcome]}
  </Badge>
);
