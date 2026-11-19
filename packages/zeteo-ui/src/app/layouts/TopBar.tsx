import { AppTopBar, AppTopBarLink } from "@kosmeo-ui/react";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { USER_SECTIONS, isListed } from "../sections";
import { NavLink } from "react-router-dom";
import { useAuth } from "@tereo-io/react";
import { AdminMenu } from "./AdminMenu";
import { UserMenu } from "./UserMenu";

export const TopBar = () => {
  const { hasPermission } = useAuth();
  return (
    <AppTopBar
      navLabel="Sections"
      brand={<span>zeteo</span>}
      actions={
        <>
          <ThemeToggleButton />
          <UserMenu />
        </>
      }
    >
      {USER_SECTIONS.filter((s) => isListed(s, hasPermission)).map((s) => (
        <AppTopBarLink key={s.path} as={NavLink} to={s.path}>
          {s.label}
        </AppTopBarLink>
      ))}
      <AdminMenu />
    </AppTopBar>
  );
};
