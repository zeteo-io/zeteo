import type { Calendar, CalendarInput } from "../types/calendar.js";
import { send, type CallContext } from "../send.js";

export const calendarCalls = (ctx: CallContext) => ({
  get: (): Promise<Calendar> => send(ctx, { op: "getCalendar" }),
  /** Replaces the whole calendar, so repeating it after a 5xx is harmless. */
  replace: (body: CalendarInput): Promise<Calendar> =>
    send(ctx, { op: "replaceCalendar", body, once: false }),
});
