import { AppTopBar, AppTopBarLink } from "@kosmeo-ui/react";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { NavLink } from "react-router-dom";
import { useAuth } from "@tereo-io/react";
import { SECTIONS } from "../sections";
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
      {SECTIONS.filter((s) => hasPermission(s.permission)).map((s) => (
        <AppTopBarLink key={s.path} as={NavLink} to={s.path}>
          {s.label}
        </AppTopBarLink>
      ))}
    </AppTopBar>
  );
};
