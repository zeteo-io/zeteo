import { tokenFor } from "./tokens.js";

/** The request headers of a new user who holds `permissions`. */
export const signedIn = (permissions: string[]) => ({
  headers: { Authorization: `Bearer ${tokenFor({ permissions })}` },
});
