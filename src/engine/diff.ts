/**
 * Position diffing — detects what a leader changed between two snapshots.
 *
 * Ported 1:1 from the Dream client's `_detectPositionChanges`:
 *  - opened:    a market present now but not before.
 *  - increased: same market, |Δsize| / prevSize > 0.10 (10%).
 *  - closed:    a market present before but gone now.
 */

import type { LeaderPosition } from "../phoenix/types.js";

export type ChangeType = "opened" | "increased" | "closed";

export interface PositionChange {
  market: string;
  side: "long" | "short";
  type: ChangeType;
  position: LeaderPosition;
}

export function detectPositionChanges(
  previous: LeaderPosition[],
  current: LeaderPosition[]
): PositionChange[] {
  const changes: PositionChange[] = [];
  const prevMap = new Map(previous.map((p) => [p.market, p]));
  const currMap = new Map(current.map((p) => [p.market, p]));

  for (const curr of current) {
    const prev = prevMap.get(curr.market);
    if (!prev) {
      changes.push({ market: curr.market, side: curr.side, type: "opened", position: curr });
    } else if (prev.size > 0 && Math.abs(curr.size - prev.size) / prev.size > 0.1) {
      changes.push({ market: curr.market, side: curr.side, type: "increased", position: curr });
    }
  }

  for (const prev of previous) {
    if (!currMap.has(prev.market)) {
      changes.push({ market: prev.market, side: prev.side, type: "closed", position: prev });
    }
  }

  return changes;
}
