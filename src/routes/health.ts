import { Hono } from "hono";
import config from "../config.js";
import { privySigner } from "../privy/privy-signer.js";

const health = new Hono();

health.get("/", (c) =>
  c.json({
    ok: true,
    service: "dream-server",
    signerConfigured: privySigner.isConfigured,
    pollIntervalMs: config.LEADER_POLL_INTERVAL_MS,
  })
);

export default health;
