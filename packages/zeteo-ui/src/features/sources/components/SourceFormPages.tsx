import { useSourceContext } from "./SourceLayout";
import { SourceForm } from "./SourceForm";

export const SourceNewPage = () => (
  <div className="z-form-page">
    <SourceForm title="New source" />
  </div>
);

export const SourceEditPage = () => {
  const { source } = useSourceContext();
  return <SourceForm source={source} title="Edit source" />;
};
