import { TereoAuthProvider, type TereoAuthConfig } from "@tereo-io/react";
import { ConfigError, loadConfig, type UiConfig } from "@/lib/config";
import { toApiError, ZETEO_API, type ApiError } from "@/lib/api";
import { Centered, Spinner } from "@kosmeo-ui/react";
import { StartupError } from "@/features/auth";
import { loadMe } from "@/lib/auth";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const INSECURE_CONTEXT_MESSAGE =
  "Sign-in needs https (or localhost): this page was opened over plain http.";

const MeErrorContext = createContext<ApiError | null>(null);

/** Why the last `GET /v1/me` failed, while it keeps failing. */
export const useMeError = () => useContext(MeErrorContext);

const SignIn = ({ ui, children }: { ui: UiConfig; children: ReactNode }) => {
  const [meError, setMeError] = useState<ApiError | null>(null);
  // The provider reads its config once, at mount.
  const [config] = useState<TereoAuthConfig>(() => ({
    coreUrl: ui.tereoUrl,
    clientId: ui.clientId,
    redirectUri: `${window.location.origin}/callback`,
    // zeteo serves this UI: its API is on the page's origin.
    apis: { [ZETEO_API]: "" },
    loadUser: async (apis) => {
      try {
        const me = await loadMe(apis);
        setMeError(null);
        return me;
      } catch (err) {
        setMeError(toApiError(err));
        throw err;
      }
    },
    live: true,
    signedOutPath: "/signed-out",
  }));
  return (
    <TereoAuthProvider config={config}>
      <MeErrorContext.Provider value={meError}>
        {children}
      </MeErrorContext.Provider>
    </TereoAuthProvider>
  );
};

type Boot =
  | { status: "loading" }
  | { status: "error"; title: string; message: string }
  | { status: "ready"; ui: UiConfig };

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Reads /ui-config.json, then mounts Tereo's sign-in with it. */
export const ZeteoAuthProvider = ({ children }: { children: ReactNode }) => {
  const [boot, setBoot] = useState<Boot>(() =>
    // PKCE needs WebCrypto, which browsers give only to secure contexts.
    window.isSecureContext === false
      ? {
          status: "error",
          title: "Sign-in cannot start",
          message: INSECURE_CONTEXT_MESSAGE,
        }
      : { status: "loading" }
  );

  useEffect(() => {
    if (boot.status !== "loading") return;
    let current = true;
    loadConfig().then(
      (ui) => {
        if (current) setBoot({ status: "ready", ui });
      },
      (err: unknown) => {
        if (!current) return;
        setBoot({
          status: "error",
          title: "zeteo's admin UI is not available",
          message:
            err instanceof ConfigError
              ? err.message
              : `The UI configuration could not be read: ${messageOf(err)}`,
        });
      }
    );
    return () => {
      current = false;
    };
  }, [boot.status]);

  switch (boot.status) {
    case "loading":
      return (
        <Centered>
          <Spinner size="lg" />
        </Centered>
      );
    case "error":
      return (
        <StartupError
          title={boot.title}
          message={boot.message}
          onRetry={() => window.location.reload()}
        />
      );
    case "ready":
      return <SignIn ui={boot.ui}>{children}</SignIn>;
  }
};
