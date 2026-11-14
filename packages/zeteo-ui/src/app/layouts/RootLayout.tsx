import { ToastContainer } from "react-toastify";
import { Outlet } from "react-router-dom";
import { useTheme } from "@/lib/theme";
import { TopBar } from "./TopBar";
import "./RootLayout.css";
import "../toasts.css";

// Its own component so the container follows the theme provider's theme.
const ThemedToastContainer = () => {
  const { resolvedTheme } = useTheme();
  return (
    <ToastContainer
      position="top-right"
      autoClose={5000}
      newestOnTop
      closeOnClick
      pauseOnHover
      theme={resolvedTheme}
    />
  );
};

export const RootLayout = () => (
  <div className="z-root">
    <TopBar />
    <main className="z-body">
      <Outlet />
    </main>
    <ThemedToastContainer />
  </div>
);
