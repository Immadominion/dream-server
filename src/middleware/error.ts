/** Simple app-wide error handler for Hono. */

import type { Context } from "hono";
import config from "../config.js";
import { logger } from "../logger.js";

export function errorHandler(err: Error, c: Context): Response {
    logger.error({ err, path: c.req.path, method: c.req.method }, "request failed");
    return c.json(
        {
            error: "Internal server error",
            // Internal details only outside production.
            ...(config.NODE_ENV === "production" ? {} : { message: err.message }),
        },
        500
    );
}
