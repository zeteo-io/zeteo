import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ZeteoAuthProvider } from "./ZeteoAuthProvider";
import { ThemeProvider } from "@/lib/theme";
import type { ReactNode } from "react";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

interface AppProviderProps {
  children: ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <ZeteoAuthProvider>{children}</ZeteoAuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);
