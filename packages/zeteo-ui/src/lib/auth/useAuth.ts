import { createContext, useContext } from "react";

export interface Me {
  id: string;
  type: "user" | "service";
  name: string | null;
  email: string | null;
  permissions: string[];
}

export interface AuthValue {
  me: Me;
  can: (permission: string) => boolean;
  signOut: () => void;
}

export const AuthContext = createContext<AuthValue | null>(null);

export const useAuth = (): AuthValue => {
  const value = useContext(AuthContext);
  if (!value)
    throw new Error("useAuth is used outside a signed-in AuthProvider");
  return value;
};
