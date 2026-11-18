// The dashboard grid as the server lays panels out, shared by the app's grid
// and the MCP preview card (which must not pull in react-grid-layout).

/** The grid's columns, as the server lays panels out. */
export const GRID_COLUMNS = 12;
/** The tallest a panel may be, in rows, as the server allows. */
export const MAX_PANEL_HEIGHT = 24;
/** One grid row's height, in pixels. */
export const GRID_ROW_HEIGHT = 80;
/** The gap between panels, in pixels. */
export const GRID_GAP = 12;
