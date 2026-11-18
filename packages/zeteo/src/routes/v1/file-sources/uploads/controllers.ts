import { ValidationError } from "../../../../utils/errors.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import type { Readable } from "node:stream";
import busboy from "busboy";
import {
  discardStaging,
  stageUpload,
} from "../../../../file-sources/staging.js";

type Staged = Awaited<ReturnType<typeof stageUpload>>;

/**
 * `POST /v1/file-sources/uploads`: one file in the multipart field `file`,
 * staged as it streams in.
 *
 * A client that goes away (or a request the server times out) destroys the
 * file stream with an error, so the staging in progress fails and drops its
 * tables. A refused upload (too large, wrong type, unreadable, a second file)
 * is answered at once with `Connection: close` and the request is cut, not
 * read to its end.
 */
export const postUpload = async (req: Request, res: Response) => {
  const ownerId = callerOf(req).userId;
  let parser: busboy.Busboy;
  try {
    parser = busboy({ headers: req.headers, limits: { files: 1, fields: 5 } });
  } catch {
    throw new ValidationError("Send the file as multipart/form-data");
  }

  let fileStream: Readable | null = null;
  let staged: Promise<Staged> | null = null;
  let refused: Error | null = null;
  let aborted = false;
  let settle: ((err: Error) => void) | null = null;

  const abort = () => {
    if (aborted) return;
    aborted = true;
    const err = new Error("The upload was aborted");
    fileStream?.destroy(err);
    parser.destroy();
    settle?.(err);
  };
  req.on("aborted", abort);
  req.on("error", abort);
  res.on("close", () => {
    if (!res.writableEnded) abort();
  });

  let result: Staged;
  try {
    result = await new Promise<Staged>((resolve, reject) => {
      settle = reject;
      // A refusal cancels the first file's staging and removes what it made.
      const refuse = async (err: Error) => {
        if (refused) return;
        refused = err;
        fileStream?.destroy(err);
        if (staged) {
          try {
            await discardStaging((await staged).stagingId);
          } catch {
            // It failed (and cleaned up) or was never made.
          }
        }
        reject(err);
      };
      parser.on("file", (field, file, info) => {
        file.on("error", () => undefined);
        if (field !== "file" || staged) {
          file.resume();
          void refuse(
            new ValidationError("Send one file, in the field `file`")
          );
          return;
        }
        fileStream = file;
        staged = stageUpload({
          ownerId,
          filename: info.filename ?? "",
          stream: file,
        });
        // A failure ends the request at once; success waits for the close.
        staged.catch((err: unknown) => reject(err));
      });
      parser.on("filesLimit", () => {
        void refuse(new ValidationError("Send one file, in the field `file`"));
      });
      parser.on("error", (err) => {
        reject(
          new ValidationError(
            `The upload is not valid multipart: ${(err as Error).message}`
          )
        );
      });
      parser.on("close", () => {
        if (refused) return;
        if (!staged) {
          return reject(new ValidationError("Send a file in the field `file`"));
        }
        staged.then(resolve, reject);
      });
      req.pipe(parser);
    });
  } catch (err) {
    // Nothing to answer to a client that has gone.
    if (aborted) return;
    res.setHeader("Connection", "close");
    if (!req.complete) res.once("finish", () => req.destroy());
    throw err;
  }

  if (aborted) {
    await discardStaging(result.stagingId);
    return;
  }
  res.status(201).json({
    staging_id: result.stagingId,
    expires_at: result.expiresAt.toISOString(),
    tables: result.tables,
  });
};
