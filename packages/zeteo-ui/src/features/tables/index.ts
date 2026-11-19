export { TablesPage, TablesList } from "./components/TablesPage";
export {
  TablePage,
  TableView,
  type ColumnEditing,
  type ColumnTypeChoice,
} from "./components/TablePage";
export { useTable } from "./api/useTable";
export { useAllTables, tableLabel } from "./api/useAllTables";
export { useCanEditCatalogue } from "./api/useCanEditCatalogue";
export type {
  Table,
  TableDetail,
  TableOrigin,
  Column,
  MergedDetail,
} from "./api/types";
