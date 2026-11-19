export interface ZeteoErrorInit {
  status?: number | null;
  code: string;
  requestId?: string;
  issues?: { path: string; message: string }[];
  retryAfter?: number;
  findings?: unknown[];
  /** `invalid_panel`: each setting at fault and why. */
  problems?: { setting: string; problem: string }[];
  /** `measure_in_use`: the measures and metrics that would break, measures first. */
  dependents?: MeasureDependent[];
  cause?: Error;
}

/** A measure or metric that uses the measure a change or delete would break. */
export interface MeasureDependent {
  kind: "measure" | "metric";
  name: string;
}

export class ZeteoError extends Error {
  status: number | null;
  code: string;
  requestId?: string;
  issues?: { path: string; message: string }[];
  retryAfter?: number;
  findings?: unknown[];
  problems?: { setting: string; problem: string }[];
  dependents?: MeasureDependent[];

  constructor(message: string, init: ZeteoErrorInit) {
    super(message, init.cause ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.status = init.status ?? null;
    this.code = init.code;
    this.requestId = init.requestId;
    this.issues = init.issues;
    this.retryAfter = init.retryAfter;
    this.findings = init.findings;
    this.problems = init.problems;
    this.dependents = init.dependents;
  }
}

export class QueryRefusedError extends ZeteoError {
  path: (string | number)[];
  suggestions: string[];

  constructor(
    message: string,
    init: ZeteoErrorInit & { path: (string | number)[]; suggestions?: string[] }
  ) {
    super(message, init);
    this.path = init.path;
    this.suggestions = init.suggestions ?? [];
  }
}

export class ExportInterruptedError extends Error {
  runId: string;
  rowsRead: number;

  constructor(message: string, runId: string, rowsRead: number) {
    super(message);
    this.name = "ExportInterruptedError";
    this.runId = runId;
    this.rowsRead = rowsRead;
  }
}
