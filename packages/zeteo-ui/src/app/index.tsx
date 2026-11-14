import { Spinner } from "@kosmeo-ui/react";
import { AppProvider } from "./provider";

export const App = () => (
  <AppProvider>
    <Spinner size="lg" />
  </AppProvider>
);
