import { Callback, NoAccess, SignedOut, StartupError } from "@/features/auth";
import { ConfigError, loadConfig, type UiConfig } from "@/lib/config";
import { getTokens, subscribeTokens, type Tokens } from "./tokens";
import { AuthContext, type AuthValue, type Me } from "./useAuth";
import { Centered, Spinner } from "@kosmeo-ui/react";
import { hasPermission } from "./permissions";
import { fetchMe, MeError } from "./me";
import {
  AuthError,
  CALLBACK_PATH,
  completeLogin,
  renew,
  signOut,
  startLogin,
} from "./oauth";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const RENEW_BEFORE_EXPIRY_MS = 60_000;
const RENEW_RETRY_MS = 30_000;

// Answers to a silent (prompt=none) login that mean "sign in on Tereo's page".
const NEEDS_INTERACTION = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
]);

type State =
  | { status: "loading" }
  | { status: "signed-in"; me: Me }
  | { status: "no-access"; me: Me }
  | { status: "signed-out"; code: string }
  | { status: "error"; title: string; message: string; canSignOut: boolean };

const currentPath = () =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<State>({ status: "loading" });
  const cfgRef = useRef<UiConfig | null>(null);
  const started = useRef(false);
  const signingOut = useRef(false);
  const onCallback = useRef(window.location.pathname === CALLBACK_PATH);

  const redirect = useCallback(
    async (cfg: UiConfig, opts: { silent?: boolean; returnTo?: string }) => {
      try {
        await startLogin(cfg, opts);
      } catch (err) {
        // crypto.subtle and sessionStorage are missing outside a secure
        // context (https or localhost) or with storage blocked.
        setState({
          status: "error",
          title: "Sign-in cannot start",
          message: `This browser could not start a sign-in: ${messageOf(err)}`,
          canSignOut: false,
        });
      }
    },
    []
  );

  const loadMe = useCallback(async (cfg: UiConfig) => {
    try {
      let me: Me;
      try {
        me = await fetchMe(getTokens()?.accessToken ?? "");
      } catch (err) {
        if (!(err instanceof MeError && err.status === 401)) throw err;
        me = await fetchMe((await renew(cfg)).accessToken);
      }
      setState(
        me.permissions.length === 0
          ? { status: "no-access", me }
          : { status: "signed-in", me }
      );
    } catch (err) {
      setState({
        status: "error",
        title: "Your account could not be loaded",
        message:
          err instanceof AuthError
            ? `Renewing the sign-in failed: ${err.code}`
            : messageOf(err),
        canSignOut: getTokens() !== null,
      });
    }
  }, []);

  const boot = useCallback(async () => {
    let cfg: UiConfig;
    try {
      cfg = await loadConfig();
    } catch (err) {
      setState({
        status: "error",
        title: "zeteo's admin UI is not available",
        message:
          err instanceof ConfigError
            ? err.message
            : `The UI configuration could not be read: ${messageOf(err)}`,
        canSignOut: false,
      });
      return;
    }
    cfgRef.current = cfg;

    if (onCallback.current) {
      const callbackUrl = new URL(window.location.href);
      try {
        const { returnTo } = await completeLogin(cfg, callbackUrl);
        // The code and state must not stay in the address bar or history.
        window.history.replaceState(null, "", returnTo);
      } catch (err) {
        window.history.replaceState(null, "", "/");
        const code = err instanceof AuthError ? err.code : "sign_in_failed";
        // returnTo is set only when the error answers the login this tab
        // started, so a stray or bookmarked callback never redirects.
        if (
          err instanceof AuthError &&
          err.returnTo !== undefined &&
          NEEDS_INTERACTION.has(code)
        ) {
          await redirect(cfg, { returnTo: err.returnTo });
          return;
        }
        setState({ status: "signed-out", code });
        return;
      }
    } else if (!getTokens()) {
      await redirect(cfg, { silent: true, returnTo: currentPath() });
      return;
    }
    await loadMe(cfg);
  }, [loadMe, redirect]);

  useEffect(() => {
    // Once per page load: StrictMode runs this effect twice, and a second
    // boot would start a second redirect or exchange the code again.
    if (started.current) return;
    started.current = true;
    void boot();
  }, [boot]);

  const signedIn = state.status === "signed-in";
  useEffect(() => {
    const cfg = cfgRef.current;
    if (!signedIn || !cfg) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      renew(cfg).catch(() => {
        if (signingOut.current) return;
        if (getTokens()) {
          timer = setTimeout(run, RENEW_RETRY_MS);
        } else {
          void redirect(cfg, { silent: true, returnTo: currentPath() });
        }
      });
    };
    const schedule = (tokens: Tokens | null) => {
      clearTimeout(timer);
      if (!tokens) return;
      const delay = tokens.expiresAt - RENEW_BEFORE_EXPIRY_MS - Date.now();
      timer = setTimeout(run, Math.max(0, delay));
    };

    schedule(getTokens());
    const unsubscribe = subscribeTokens(schedule);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [signedIn, redirect]);

  const doSignOut = useCallback(() => {
    const cfg = cfgRef.current;
    if (!cfg || signingOut.current) return;
    signingOut.current = true;
    setState({ status: "loading" });
    void signOut(cfg);
  }, []);

  const signIn = useCallback(() => {
    const cfg = cfgRef.current;
    if (cfg) void redirect(cfg, { returnTo: "/" });
  }, [redirect]);

  const me = state.status === "signed-in" ? state.me : null;
  const value = useMemo<AuthValue | null>(
    () =>
      me && {
        me,
        can: (permission: string) => hasPermission(me.permissions, permission),
        signOut: doSignOut,
      },
    [me, doSignOut]
  );

  switch (state.status) {
    case "loading":
      return onCallback.current && !signingOut.current ? (
        <Callback />
      ) : (
        <Centered>
          <Spinner size="lg" />
        </Centered>
      );
    case "signed-out":
      return <SignedOut code={state.code} onSignIn={signIn} />;
    case "no-access":
      return <NoAccess me={state.me} onSignOut={doSignOut} />;
    case "error":
      return (
        <StartupError
          title={state.title}
          message={state.message}
          onRetry={() => window.location.reload()}
          onSignOut={state.canSignOut ? doSignOut : undefined}
        />
      );
    case "signed-in":
      return (
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
      );
  }
};
