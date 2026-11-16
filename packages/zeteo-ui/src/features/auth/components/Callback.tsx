import { Centered, Spinner } from "@kosmeo-ui/react";
import { useCompleteSignIn } from "@tereo-io/react";
import { describeSignInError } from "./SignedOut";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

/** /callback: exchanges Tereo's code, then replaces the address with the page asked for. */
export const Callback = () => {
  const { complete } = useCompleteSignIn();
  const navigate = useNavigate();

  useEffect(() => {
    complete(new URLSearchParams(window.location.search)).then(
      ({ returnTo }) => navigate(returnTo ?? "/", { replace: true }),
      // The code and state must not stay in the address bar or history.
      (err: unknown) =>
        navigate("/signed-out", {
          replace: true,
          state: { error: describeSignInError(err) },
        })
    );
  }, [complete, navigate]);

  return (
    <Centered>
      <Spinner size="lg" />
      <p>Signing you in…</p>
    </Centered>
  );
};
