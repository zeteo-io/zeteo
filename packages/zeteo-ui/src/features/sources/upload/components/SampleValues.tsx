import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@kosmeo-ui/react";

/** A column's sample values, cut to two lines with a button at the right that shows them all when they do not fit. */
export const SampleValues = ({ samples }: { samples: string[] }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, samples]);

  return (
    <span className="z-fs-samples-cell">
      <span
        ref={ref}
        className={`z-fs-samples${expanded ? "" : " z-fs-samples-clamped"}`}
      >
        {samples.join(", ")}
      </span>
      {(overflows || expanded) && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      )}
    </span>
  );
};
