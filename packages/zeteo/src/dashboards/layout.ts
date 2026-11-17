// A dashboard's grid: 12 columns, rows without end. A panel is a rectangle
// of cells.

export const GRID_COLUMNS = 12;

/** The most panels a dashboard holds. */
export const MAX_PANELS = 50;

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Cell, b: Cell): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where a panel of `size` goes among `existing`: the first free place scanning
 * rows from the top and columns from the left. There is always one, at the
 * latest below everything. A width over the grid is cut to it.
 */
export const placePanel = (
  existing: readonly Cell[],
  size: { w: number; h: number }
): { x: number; y: number } => {
  const w = Math.min(size.w, GRID_COLUMNS);
  const bottom = Math.max(0, ...existing.map((c) => c.y + c.h));
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w, h: size.h };
      if (!existing.some((c) => overlaps(candidate, c))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
};
