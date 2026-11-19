import { SourceDetailPage } from "../components/SourceDetailPage";
import { SourceLayout } from "../components/SourceLayout";
import { Route, Routes } from "react-router-dom";
import {
  SourceRelationsPage,
  SourceSharingPage,
  SourceTablePage,
  SourceTablesPage,
} from "../components/SourceTabs";

/** A source's routes as `routes.tsx` nests them, plus the pages tests navigate to. */
export const SourceTestRoutes = () => (
  <Routes>
    <Route path="/sources/:sourceId" element={<SourceLayout />}>
      <Route index element={<SourceDetailPage />} />
      <Route path="tables" element={<SourceTablesPage />} />
      <Route path="tables/:tableId" element={<SourceTablePage />} />
      <Route path="relations" element={<SourceRelationsPage />} />
      <Route path="sharing" element={<SourceSharingPage />} />
    </Route>
    <Route path="/my" element={<p>My Zeteo</p>} />
    <Route path="/sources" element={<p>Sources list</p>} />
    <Route path="/sources/:sourceId/add" element={<p>Add tables page</p>} />
    <Route
      path="/sources/:sourceId/merged/new"
      element={<p>Add merged table page</p>}
    />
    <Route
      path="/sources/:sourceId/tables/:tableId/reupload"
      element={<p>Re-upload page</p>}
    />
  </Routes>
);
