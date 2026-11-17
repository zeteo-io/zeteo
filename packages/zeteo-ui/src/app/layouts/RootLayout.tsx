import { Outlet } from "react-router-dom";
import { TopBar } from "./TopBar";
import "./RootLayout.css";

export const RootLayout = () => (
  <div className="z-root">
    <TopBar />
    <main className="z-body">
      <Outlet />
    </main>
  </div>
);
