import { readGoogleConnectionView } from "../../../../google/connectionStore.js";
import { invalidRequest, validateBody } from "../../../../utils/validateReq.js";
import { connectionView } from "../../../../views/connection.js";
import { callerOf } from "../../../../middleware/auth.js";
import { PutGoogleConnectionSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  ServiceAccountKeySchema,
  putGoogleConnection,
} from "../../../../google/connection.js";
import {
  ValidationError,
  GoogleNotConfiguredError,
} from "../../../../utils/errors.js";

export const getGoogleConnection = async (_req: Request, res: Response) => {
  const row = await readGoogleConnectionView();
  if (!row) throw new GoogleNotConfiguredError();
  res.status(200).json(connectionView(row));
};

export const putGoogle = async (req: Request, res: Response) => {
  const body = validateBody(PutGoogleConnectionSchema, req);
  let raw: unknown = body.service_account_key;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // The parser's message quotes the text, which is the key.
      throw new ValidationError("service_account_key is not valid JSON");
    }
  }
  const parsed = ServiceAccountKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidRequest("body", parsed.error);
  }
  res.status(200).json(await putGoogleConnection(callerOf(req), parsed.data));
};
