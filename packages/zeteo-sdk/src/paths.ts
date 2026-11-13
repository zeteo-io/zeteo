import { ZeteoError } from "./errors.js";

const FORBIDDEN = /[/?#\\]/;

export function buildPath(
  template: string,
  params: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (
      typeof value !== "string" ||
      value === "" ||
      value === ".." ||
      FORBIDDEN.test(value)
    ) {
      throw new ZeteoError(`invalid ${name}`, {
        status: null,
        code: "invalid_id",
      });
    }
    return encodeURIComponent(value);
  });
}
