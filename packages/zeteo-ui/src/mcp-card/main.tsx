import { connectHost, readKind } from "./host";
import { createRoot } from "react-dom/client";
import "@kosmeo-ui/react/styles.css";
import { CardApp } from "./CardApp";
import { StrictMode } from "react";
import "./styles.css";

// The MCP Apps preview card: one self-contained page (dist-mcp/card.html),
// served by zeteo as a ui:// resource with a <meta name="zeteo-card"> that
// says which card to draw.
const el = document.getElementById("root");
if (!el) throw new Error("No root element found");
const root = createRoot(el);
const note = (text: string) =>
  root.render(<p className="zc-message">{text}</p>);

const kind = readKind(document);
if (!kind) {
  note("This card does not say what to show.");
} else {
  connectHost(kind).then(
    (host) =>
      root.render(
        <StrictMode>
          <CardApp host={host} />
        </StrictMode>
      ),
    () => note("The preview could not connect to its host.")
  );
}
