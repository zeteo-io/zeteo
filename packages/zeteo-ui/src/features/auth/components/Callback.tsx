import { Centered, Spinner } from "@kosmeo-ui/react";

/** Shown on /callback while the code is exchanged. */
export const Callback = () => (
  <Centered>
    <Spinner size="lg" />
    <p>Signing you in…</p>
  </Centered>
);
