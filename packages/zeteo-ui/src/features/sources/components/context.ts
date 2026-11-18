import { useOutletContext } from "react-router-dom";
import type { SourceAccess } from "./access";
import type { Source } from "../api/types";

export interface SourceContext {
  source: Source;
  access: SourceAccess;
}

/** The source the surrounding `SourceLayout` loaded, and what the caller may do with it. */
export const useSourceContext = () => useOutletContext<SourceContext>();
