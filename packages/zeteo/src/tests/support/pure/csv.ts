/**
 * A small RFC 4180 reader: records end with CRLF, a field is quoted when it
 * holds `"`, `,`, CR or LF, and `""` inside quotes is one `"`. Each field is
 * returned with whether it was quoted, so an empty quoted field (`""`) can be
 * told from an empty unquoted one. Throws on anything malformed, including a
 * last record without its CRLF.
 */
export const readCsv = (
  text: string
): { value: string; quoted: boolean }[][] => {
  const records: { value: string; quoted: boolean }[][] = [];
  let record: { value: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    let value = "";
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= text.length) throw new Error("unterminated quoted field");
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
    } else {
      while (i < text.length && !/[,\r\n"]/.test(text[i]!)) {
        value += text[i];
        i++;
      }
      if (text[i] === '"')
        throw new Error(`a quote inside an unquoted field at ${i}`);
    }
    record.push({ value, quoted });
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text.startsWith("\r\n", i)) {
      records.push(record);
      record = [];
      i += 2;
      continue;
    }
    throw new Error(`expected a comma or CRLF at ${i}`);
  }
  if (record.length > 0) throw new Error("the last record has no CRLF");
  return records;
};

/** The records' values only. */
export const readCsvValues = (text: string): string[][] =>
  readCsv(text).map((record) => record.map((field) => field.value));
