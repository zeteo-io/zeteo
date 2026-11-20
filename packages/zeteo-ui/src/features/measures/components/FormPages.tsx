import { isRedacted, isRedactedMetric } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useMeasures } from "../api/useMeasures";
import { useMetrics } from "../api/useMetrics";
import { useNavigate } from "react-router-dom";
import { MeasureForm } from "./MeasureForm";
import { Spinner } from "@kosmeo-ui/react";
import { MetricForm } from "./MetricForm";

const tabHref = (sourceId: string, tab: "measures" | "metrics") =>
  `/sources/${sourceId}/${tab}`;

/** `/sources/:sourceId/measures/new` */
export const MeasureNewPage = () => {
  const navigate = useNavigate();
  const sourceId = useUuidParam("sourceId");
  if (!sourceId) return <NotFound />;
  return (
    <MeasureForm
      sourceId={sourceId}
      onDone={() => navigate(tabHref(sourceId, "measures"))}
    />
  );
};

/** `/sources/:sourceId/measures/:measureId/edit`: only an editor's, and only a measure they can see whole. */
export const MeasureEditPage = () => {
  const navigate = useNavigate();
  const sourceId = useUuidParam("sourceId");
  const measureId = useUuidParam("measureId");
  const { data, isLoading, error } = useMeasures(sourceId ?? "");
  if (!sourceId || !measureId) return <NotFound />;
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  const measure = data.data.find((m) => !isRedacted(m) && m.id === measureId);
  if (!data.can_edit || !measure || isRedacted(measure)) return <NotFound />;
  return (
    <MeasureForm
      key={measure.id}
      sourceId={sourceId}
      measure={measure}
      onDone={() => navigate(tabHref(sourceId, "measures"))}
    />
  );
};

/** `/sources/:sourceId/metrics/new` */
export const MetricNewPage = () => {
  const navigate = useNavigate();
  const sourceId = useUuidParam("sourceId");
  if (!sourceId) return <NotFound />;
  return (
    <MetricForm
      sourceId={sourceId}
      onDone={() => navigate(tabHref(sourceId, "metrics"))}
    />
  );
};

/** `/sources/:sourceId/metrics/:metricId/edit` */
export const MetricEditPage = () => {
  const navigate = useNavigate();
  const sourceId = useUuidParam("sourceId");
  const metricId = useUuidParam("metricId");
  const { data, isLoading, error } = useMetrics(sourceId ?? "");
  if (!sourceId || !metricId) return <NotFound />;
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  const metric = data.data.find(
    (m) => !isRedactedMetric(m) && m.id === metricId
  );
  if (!data.can_edit || !metric || isRedactedMetric(metric))
    return <NotFound />;
  return (
    <MetricForm
      key={metric.id}
      sourceId={sourceId}
      metric={metric}
      onDone={() => navigate(tabHref(sourceId, "metrics"))}
    />
  );
};
