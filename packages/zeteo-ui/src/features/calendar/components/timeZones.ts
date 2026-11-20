/**
 * Current IANA names that browsers' ICU lists under a legacy name
 * (`Asia/Calcutta`). The server accepts both, so both are offered.
 */
const CURRENT_NAMES = [
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Yangon",
  "Asia/Ho_Chi_Minh",
  "Atlantic/Faroe",
  "Europe/Kyiv",
  "America/Argentina/Buenos_Aires",
  "America/Indiana/Indianapolis",
  "America/Kentucky/Louisville",
  "America/Nuuk",
  "Pacific/Kanton",
  "Pacific/Chuuk",
  "Pacific/Pohnpei",
];

/**
 * Whether the server takes `zone`: `UTC` or a region name with a "/". It
 * refuses names such as `CET` or `EST5EDT`, which Postgres may read as fixed
 * offsets with no summer time.
 */
export const isAcceptedZone = (zone: string): boolean =>
  zone === "UTC" || zone.includes("/");

/**
 * The time zones to offer: UTC first, then the browser's list with the current
 * names above and `saved` (whatever the calendar holds), each once, sorted;
 * only names the server takes.
 */
export const timeZoneOptions = (saved?: string): string[] => {
  const zones = new Set<string>([
    ...Intl.supportedValuesOf("timeZone"),
    ...CURRENT_NAMES,
  ]);
  if (saved) zones.add(saved);
  zones.delete("UTC");
  return ["UTC", ...[...zones].filter(isAcceptedZone).sort()];
};
