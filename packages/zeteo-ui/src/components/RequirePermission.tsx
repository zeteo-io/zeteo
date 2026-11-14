import { NoAccessSection } from "./NoAccessSection";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";

interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
}

export const RequirePermission = ({
  permission,
  children,
}: RequirePermissionProps) => {
  const { can } = useAuth();
  return can(permission) ? (
    children
  ) : (
    <NoAccessSection permission={permission} />
  );
};
