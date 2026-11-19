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
 * The time zones to offer: UTC first, then the browser's list with the current
 * names above and `saved` (whatever the calendar holds), each once, sorted.
 */
export const timeZoneOptions = (saved?: string): string[] => {
  const zones = new Set<string>([
    ...Intl.supportedValuesOf("timeZone"),
    ...CURRENT_NAMES,
  ]);
  if (saved) zones.add(saved);
  zones.delete("UTC");
  return ["UTC", ...[...zones].sort()];
};
