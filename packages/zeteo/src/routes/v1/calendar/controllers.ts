import { validateBody } from "../../../utils/validateReq.js";
import type { Weekday } from "../../../calendar/calendar.js";
import { calendarView } from "../../../views/calendar.js";
import { callerOf } from "../../../middleware/auth.js";
import { PutCalendarSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  loadStoredCalendar,
  replaceCalendar,
} from "../../../calendar/service.js";

export const getCalendar = async (_req: Request, res: Response) => {
  res.status(200).json(calendarView(await loadStoredCalendar()));
};

export const putCalendar = async (req: Request, res: Response) => {
  const body = validateBody(PutCalendarSchema, req);
  await replaceCalendar(
    { ...body, working_days: body.working_days as Weekday[] },
    callerOf(req).userId
  );
  res.status(200).json(calendarView(await loadStoredCalendar()));
};
