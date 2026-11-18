import { InvalidSheetLinkError } from "../utils/errors.js";

const BARE_ID = /^[A-Za-z0-9_-]{25,100}$/;
const PATH_ID = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{25,100})(?:\/|$)/;

/**
 * The spreadsheet id in a pasted Google Sheets link (`https://docs.google.com/spreadsheets/d/<id>/…`)
 * or a bare id. Any other host or scheme, another kind of document and a published-to-web link
 * (`/spreadsheets/d/e/…`, which carries no spreadsheet id) are refused.
 */
export function parseSheetLink(input: string): string {
  const text = input.trim();
  if (BARE_ID.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidSheetLinkError();
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new InvalidSheetLinkError();
  }
  const match = PATH_ID.exec(url.pathname);
  if (!match) throw new InvalidSheetLinkError();
  return match[1]!;
}
