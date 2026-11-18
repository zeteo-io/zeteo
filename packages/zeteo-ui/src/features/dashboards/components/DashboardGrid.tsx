import GridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { Panel } from "../api/types";
import type { ReactNode } from "react";
import {
  GRID_COLUMNS,
  GRID_GAP,
  GRID_ROW_HEIGHT,
  MAX_PANEL_HEIGHT,
} from "../grid";

export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DashboardGridProps {
  panels: Panel[];
  /** Places changed in edit mode, by panel id; others stay where the server has them. */
  places?: Record<string, Place>;
  /** Drag (by the panel's header) and resize, only while editing. */
  editing: boolean;
  onPlacesChange?: (places: Record<string, Place>) => void;
  renderPanel: (panel: Panel) => ReactNode;
}

/** The dashboard's 12-column grid of panels. */
export const DashboardGrid = ({
  panels,
  places = {},
  editing,
  onPlacesChange,
  renderPanel,
}: DashboardGridProps) => {
  const { width, containerRef } = useContainerWidth();
  const layout: Layout = panels.map((p) => ({
    i: p.id,
    ...(places[p.id] ?? { x: p.x, y: p.y, w: p.w, h: p.h }),
    minW: 2,
    minH: 2,
    // The server refuses a panel taller than 24 rows.
    maxH: MAX_PANEL_HEIGHT,
  }));

  return (
    <div ref={containerRef} className="z-dashboard-grid">
      <GridLayout
        width={width}
        layout={layout}
        gridConfig={{
          cols: GRID_COLUMNS,
          rowHeight: GRID_ROW_HEIGHT,
          margin: [GRID_GAP, GRID_GAP],
        }}
        dragConfig={{
          enabled: editing,
          handle: ".z-panel-head",
          cancel: "button, a, input",
        }}
        resizeConfig={{ enabled: editing }}
        onLayoutChange={(next) => {
          if (!editing || !onPlacesChange) return;
          onPlacesChange(
            Object.fromEntries(
              next.map((item) => [
                item.i,
                { x: item.x, y: item.y, w: item.w, h: item.h },
              ])
            )
          );
        }}
      >
        {panels.map((p) => (
          <div key={p.id}>{renderPanel(p)}</div>
        ))}
      </GridLayout>
    </div>
  );
};
