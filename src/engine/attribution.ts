/**
 * Copy attribution — best-effort notification to the Dream worker so
 * broadcasters earn their revenue share when a copier opens a mirrored trade.
 *
 * Non-fatal by design: a mirror must still succeed even if attribution fails.
 */

import config from "../config.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "attribution" });

export interface AttributionEvent {
  walletAddress: string;
  broadcasterAddress: string;
  market: string;
  side: string;
  notionalUsdc: number;
  eventType: string;
}

export async function recordCopyAttribution(event: AttributionEvent): Promise<void> {
  if (!config.DREAM_WORKER_URL) return;
  try {
    await fetch(`${config.DREAM_WORKER_URL}/v1/broadcasters/attribution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (err) {
    log.warn({ err, market: event.market }, "attribution failed (non-fatal)");
  }
}
