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

async function bootstrap(): Promise<void> {
  await runMigrations();
  await orchestrator.start();

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
}

void bootstrap();
