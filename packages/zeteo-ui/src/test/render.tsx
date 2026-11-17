import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

interface RenderOptions {
  route?: string;
  // Reserved for the sign-in mock added with the auth module.
  permissions?: string[];
}

export const renderWithProviders = (
  ui: ReactElement,
  { route = "/" }: RenderOptions = {}
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};
