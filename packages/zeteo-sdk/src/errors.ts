export interface ZeteoErrorInit {
  status?: number | null;
  code: string;
  requestId?: string;
  issues?: { path: string; message: string }[];
  retryAfter?: number;
  findings?: unknown[];
  cause?: Error;
}

export class ZeteoError extends Error {
  status: number | null;
  code: string;
  requestId?: string;
  issues?: { path: string; message: string }[];
  retryAfter?: number;
  findings?: unknown[];

  constructor(message: string, init: ZeteoErrorInit) {
    super(message, init.cause ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.status = init.status ?? null;
    this.code = init.code;
    this.requestId = init.requestId;
    this.issues = init.issues;
    this.retryAfter = init.retryAfter;
    this.findings = init.findings;
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
