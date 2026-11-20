// @module-tag int
// @module-tag platform
import { describeBusinessDays } from "../../support/businessDays.js";
import { usePostgresRuns } from "../../support/postgresRuns.js";

const { runWithCalendar } = usePostgresRuns();

describeBusinessDays("postgres", runWithCalendar);
