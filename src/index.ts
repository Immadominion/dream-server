/**
 * Dream Server — main entry point.
 *
 * Hono on Node.js server providing the always-on copy-trading backend.
 *
 * Responsibilities:
 *  - Persist signer registrations + copy subscriptions
 *  - Run the background Phoenix leader watcher / copy orchestrator
 *  - Sign Phoenix transactions server-side through Privy authorization keys
 */

process.stdout.write(`[boot] dream-server starting (pid=${process.pid}, node=${process.version})\n`);
process.on("uncaughtException", (err) => {
    process.stdout.write(`[boot] FATAL uncaughtException: ${err?.stack ?? err}\n`);
});
process.on("unhandledRejection", (reason) => {
    process.stdout.write(
        `[boot] FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
    );
});

import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import config from "./config.js";
import { closeDatabase, runMigrations } from "./db/index.js";
import { orchestrator } from "./engine/orchestrator.js";
import { errorHandler } from "./middleware/error.js";
import { logger } from "./logger.js";
import copyRoutes from "./routes/copy.js";
import healthRoutes from "./routes/health.js";
import { broadcastersPublic, broadcastersAuth } from "./routes/broadcasters.js";
import { analyticsRoutes, telegramRoutes } from "./routes/analytics.js";

process.stdout.write(`[boot] config loaded (PORT=${config.PORT}, NODE_ENV=${config.NODE_ENV})\n`);

function parseCorsOrigins(raw: string): string | string[] {
    if (raw === "*") return "*";
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => new URL(value).origin);
}

const app = new Hono();
app.onError(errorHandler);

app.use("*", requestId());
app.use("*", secureHeaders());
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
app.use("*", honoLogger((message) => logger.info(message)));
app.use(
    "*",
    cors({
        origin: parseCorsOrigins(config.CORS_ORIGINS),
        allowHeaders: [
            "Content-Type",
            "X-Wallet-Address",
            "X-Wallet-Signature",
            "X-Timestamp",
        ],
        allowMethods: ["GET", "POST", "OPTIONS"],
    })
);

app.route("/health", healthRoutes);
app.route("/v1/copy", copyRoutes);
app.route("/v1/broadcasters", broadcastersPublic);
app.route("/v1/broadcasters", broadcastersAuth);
app.route("/v1/analytics", analyticsRoutes);
app.route("/v1/telegram", telegramRoutes);

async function bootstrap(): Promise<void> {
    // Start the HTTP server FIRST so the /health endpoint can answer the
    // platform healthcheck immediately. Migrations and the always-on
    // orchestrator are brought up afterwards in the background — they must not
    // block the server from listening (otherwise the healthcheck fails before
    // the app is ever reachable).
    const server = serve({
        fetch: app.fetch,
        port: config.PORT,
    });

    process.stdout.write(`[boot] server listening on :${config.PORT}\n`);

    const shutdown = async (): Promise<void> => {
        orchestrator.stop();
        await closeDatabase();
        server.close();
    };

    process.on("SIGINT", () => {
        void shutdown();
    });
    process.on("SIGTERM", () => {
        void shutdown();
    });

    // Bring up persistence + the copy engine. A failure here is fatal — exit so
    // the platform restarts the container rather than serving a DB-less app.
    try {
        await runMigrations();
        await orchestrator.start();
        process.stdout.write(`[boot] migrations applied + orchestrator started\n`);
    } catch (err) {
        process.stdout.write(
            `[boot] FATAL init error: ${err instanceof Error ? err.stack : String(err)}\n`
        );
        process.exit(1);
    }
}

void bootstrap();
