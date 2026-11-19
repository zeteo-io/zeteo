import type { PreviewResult as Result } from "../api/types";
import "./styles.css";

/** A preview's result: one value large, or a small table. */
export const PreviewResult = ({ result }: { result: Result }) => {
  const single = result.columns.length === 1 && result.rows.length === 1;
  const show = (v: unknown) =>
    typeof v === "number" ? v.toLocaleString() : v === null ? "—" : String(v);
  return (
    <div className="z-measure-preview">
      {single ? (
        <strong
          className="z-measure-preview-value"
          data-testid="measure-preview-value"
        >
          {show(result.rows[0]![0])}
        </strong>
      ) : result.rows.length === 0 ? (
        <span className="z-muted">No rows.</span>
      ) : (
        <table aria-label="Preview result">
          <thead>
            <tr>
              {result.columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j}>{show(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.truncated && (
        <small className="z-muted">Rows were cut off.</small>
      )}
    </div>
  );
};
