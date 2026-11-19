import { requirePermission } from "../../../middleware/auth.js";
import { getCalendar, putCalendar } from "./controllers.js";
import express, { Router } from "express";
import {
  CALENDAR_WRITE,
  DATA_READ,
} from "../../../definitions/tereoDeclaration.js";

const calendarRouter = Router();

// Up to 5,000 holidays.
const json512k = express.json({ limit: "512kb" });

calendarRouter.get("/", requirePermission(DATA_READ), getCalendar);
calendarRouter.put(
  "/",
  requirePermission(CALENDAR_WRITE),
  json512k,
  putCalendar
);

export default calendarRouter;
