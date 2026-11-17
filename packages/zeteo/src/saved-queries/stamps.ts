import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";

/**
 * Stamps a successful run of a saved query: the saved query's `last_run_at`
 * and the user's own. Called once the run is recorded and not waited for, so
 * it never rejects; a failure is logged and the run stands.
 */
export const stampSavedQueryRun = async (
  savedQueryId: string,
  userId: string
): Promise<void> => {
  try {
    await db.savedQueries.stampRun(savedQueryId, userId, new Date());
  } catch (err) {
    logger.error(
      { err, saved_query_id: savedQueryId },
      "stamping a saved query's run failed"
    );
  }
};
