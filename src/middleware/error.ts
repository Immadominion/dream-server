/** Simple app-wide error handler for Hono. */

import type { Context } from "hono";
import { logger } from "../logger.js";

export function errorHandler(err: Error, c: Context): Response {
    logger.error({ err, path: c.req.path, method: c.req.method }, "request failed");
    return c.json(
        {
            error: "Internal server error",
            message: err.message,
        },
        500
    );
}
