import { vi } from "vitest";

/**
 * What a test that renders charts needs from the browser: a ResizeObserver
 * (jsdom has none). ECharts itself is mocked in the test file:
 *
 *   const echarts = vi.hoisted(() => ({ setOption: vi.fn(), init: vi.fn() }));
 *   vi.mock("echarts/core", () => ({ init: echarts.init, use: vi.fn() }));
 */
export const stubResizeObserver = () =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
