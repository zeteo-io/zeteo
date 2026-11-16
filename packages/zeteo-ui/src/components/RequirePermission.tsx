import { NoAccessSection } from "./NoAccessSection";
import { useAuth } from "@tereo-io/react";
import type { ReactNode } from "react";

interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
}

export const RequirePermission = ({
  permission,
  children,
}: RequirePermissionProps) => {
  const { hasPermission } = useAuth();
  return hasPermission(permission) ? (
    children
  ) : (
    <NoAccessSection permission={permission} />
  );
};
