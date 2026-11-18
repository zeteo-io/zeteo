import { acquireLease } from "../engine/leases.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";
import {
  ServiceUnavailableError,
  TooManyRequestsError,
} from "../utils/errors.js";

/**
 * The bounds on uploads, beside the byte, row and column limits of one file:
 * how many uploads one user may have in flight at once, across replicas
 * (`UPLOAD_MAX_IN_FLIGHT`, a Redis lease), and how many xlsx workbooks one
 * process reads at once (`UPLOAD_XLSX_CONCURRENCY`; a workbook is read
 * whole into memory). The cap on a user's unconfirmed stagings is in
 * `staging.ts` (`checkStagingRoom`).
 */

/** How long an upload's lease lasts unless renewed: one whose process died frees its slot this soon. */
export const UPLOAD_LEASE_MS = 30_000;
/** How often an upload in flight renews its lease. */
export const UPLOAD_LEASE_RENEW_MS = 10_000;
const UPLOAD_RETRY_AFTER_SECONDS = 5;

/** How long a workbook waits for a free reading slot before the upload is refused. */
export const XLSX_WAIT_MS = 30_000;
const XLSX_RETRY_AFTER_SECONDS = 5;

/**
 * Takes one of the user's upload slots, renewed until released. Returns its
 * release, which never throws and may be called more than once. Refuses with
 * 429 `too_many_uploads` when `UPLOAD_MAX_IN_FLIGHT` are in flight, or 503
 * when Redis fails.
 */
export const acquireUploadSlot = async (
  userId: string
): Promise<() => Promise<void>> => {
  const limit = env.UPLOAD_MAX_IN_FLIGHT;
  const lease = await acquireLease(
    `file-upload:user:${userId}`,
    limit,
    UPLOAD_LEASE_MS
  );
  if (!lease) {
    throw new TooManyRequestsError(
      UPLOAD_RETRY_AFTER_SECONDS,
      `At most ${limit} upload${limit === 1 ? "" : "s"} may be in flight at once for one user`,
      "too_many_uploads"
    );
  }
  const renewal = setInterval(() => {
    void lease.renew(UPLOAD_LEASE_MS);
  }, UPLOAD_LEASE_RENEW_MS);
  renewal.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(renewal);
    await lease.release();
  };
};

let reading = 0;
const waiting: Array<() => void> = [];

/** Workbooks being read in this process, and waiting to be (for tests). */
export const xlsxGateState = () => ({
  reading,
  waiting: waiting.length,
});

const take = (): Promise<void> => {
  if (reading < env.UPLOAD_XLSX_CONCURRENCY) {
    reading += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      reading += 1;
      resolve();
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(wake);
      if (at >= 0) waiting.splice(at, 1);
      logger.warn("an upload waited too long to read its workbook");
      reject(
        new ServiceUnavailableError(
          "The server is reading other workbooks; retry shortly",
          XLSX_RETRY_AFTER_SECONDS
        )
      );
    }, XLSX_WAIT_MS);
    waiting.push(wake);
  });
};

const give = (): void => {
  reading -= 1;
  // A slot freed goes to the longest waiting, first come first served.
  if (reading < env.UPLOAD_XLSX_CONCURRENCY) waiting.shift()?.();
};

/**
 * Runs `fn` (checking, reading and staging one workbook) once fewer than
 * `UPLOAD_XLSX_CONCURRENCY` are being read in this process. One that
 * waits more than `XLSX_WAIT_MS` is refused with 503 `temporarily_unavailable`.
 */
export const withXlsxSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
  await take();
  try {
    return await fn();
  } finally {
    give();
  }
};
