/**
 * Phoenix trader-state reader.
 *
 * Fetches GET /trader/{authority}/state and extracts the leader's open
 * positions, faithfully porting the Dream client's parsing:
 *  - The response holds a `traders[]` array (one per subaccount).
 *  - Positions are AGGREGATED across all trader views (isolated positions live
 *    on non-primary subaccounts and would otherwise disappear).
 *  - `positionSize` is signed: >= 0 → long, < 0 → short; size is its absolute.
 *  - Money fields are amount objects (see ./amount.ts).
 */

import config from "../config.js";
import { logger } from "../logger.js";
import { toNumber } from "./amount.js";
import type { LeaderPosition } from "./types.js";

const log = logger.child({ module: "phoenix-trader-state" });

interface RawPosition {
  symbol?: string;
  positionSize?: unknown;
  entryPrice?: unknown;
}

interface RawTraderView {
  positions?: RawPosition[];
}

/** Fetch a leader's current open positions (size > 0), aggregated. */
export async function fetchLeaderPositions(authority: string): Promise<LeaderPosition[]> {
  try {
    const res = await fetch(`${config.PHOENIX_API_URL}/trader/${authority}/state`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      log.warn({ authority, status: res.status }, "trader state fetch failed");
      return [];
    }

    const data = (await res.json()) as { traders?: RawTraderView[] } | null;
    const traders = data?.traders ?? [];
    if (traders.length === 0) return [];

    const positions: LeaderPosition[] = [];
    for (const trader of traders) {
      for (const raw of trader.positions ?? []) {
        const signedSize = toNumber(raw.positionSize);
        const size = Math.abs(signedSize);
        if (size <= 0) continue;
        positions.push({
          market: raw.symbol ?? "",
          side: signedSize >= 0 ? "long" : "short",
          size,
          entryPrice: toNumber(raw.entryPrice),
        });
      }
    }
    return positions;
  } catch (err) {
    log.error({ authority, err }, "fetchLeaderPositions threw");
    return [];
  }
}
