import { stageUpload } from "../../../../file-sources/staging.js";
import { ValidationError } from "../../../../utils/errors.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import busboy from "busboy";

/**
 * `POST /v1/file-sources/uploads`: one file in the multipart field `file`,
 * staged as it streams in. The request is read to its end even when the file
 * is refused, so the client gets the answer and not a reset connection.
 */
export const postUpload = async (req: Request, res: Response) => {
  const ownerId = callerOf(req).userId;
  let parser: busboy.Busboy;
  try {
    parser = busboy({ headers: req.headers, limits: { files: 1, fields: 5 } });
  } catch {
    throw new ValidationError("Send the file as multipart/form-data");
  }

  const result = await new Promise<Awaited<ReturnType<typeof stageUpload>>>(
    (resolve, reject) => {
      let staged: Promise<Awaited<ReturnType<typeof stageUpload>>> | null =
        null;
      let failure: unknown = null;
      let extraFile = false;
      parser.on("file", (field, file, info) => {
        if (field !== "file" || staged) {
          extraFile = true;
          file.resume();
          return;
        }
        staged = stageUpload({
          ownerId,
          filename: info.filename ?? "",
          stream: file,
        });
        staged.catch((err: unknown) => {
          failure = err;
          file.resume();
        });
      });
      parser.on("filesLimit", () => {
        extraFile = true;
      });
      parser.on("error", (err) => {
        failure ??= new ValidationError(
          `The upload is not valid multipart: ${(err as Error).message}`
        );
      });
      parser.on("close", () => {
        if (failure) return reject(failure);
        if (extraFile) {
          return reject(
            new ValidationError("Send one file, in the field `file`")
          );
        }
        if (!staged) {
          return reject(new ValidationError("Send a file in the field `file`"));
        }
        staged.then(resolve, reject);
      });
      req.pipe(parser);
    }
  );

  res.status(201).json({
    staging_id: result.stagingId,
    expires_at: result.expiresAt.toISOString(),
    tables: result.tables,
  });
};
