import { PageHeader } from "@/components/PageHeader";
import { useSourceContext } from "./SourceLayout";
import { SourceForm } from "./SourceForm";

export const SourceNewPage = () => (
  <>
    <PageHeader title="New source" />
    <SourceForm />
  </>
);

export const SourceEditPage = () => {
  const { source } = useSourceContext();
  return <SourceForm source={source} />;
};
