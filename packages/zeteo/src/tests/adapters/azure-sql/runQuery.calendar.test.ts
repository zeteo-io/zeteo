// @module-tag int
// @module-tag platform
import { describeZonedGrouping } from "../../support/zonedGrouping.js";
import { describeBusinessDays } from "../../support/businessDays.js";
import { useMssqlRuns } from "../../support/mssqlRuns.js";

const { runWithCalendar } = useMssqlRuns();

describeBusinessDays("azure-sql", runWithCalendar);
describeZonedGrouping("azure-sql", runWithCalendar);
