/**
 * CopyOrchestrator — always-on copy-trading loop.
 *
 * Responsibilities:
 *  1. Load active copy subscriptions from Postgres.
 *  2. Poll each leader's Phoenix trader state on a fixed interval.
 *  3. Diff positions against the last snapshot.
 *  4. Mirror the resulting opens/increases/closes for each follower using the
 *     follower's delegated Privy embedded wallet.
 *  5. Persist audit rows and refresh the leader snapshot.
 *
 * Design notes:
 *  - Singleton, one loop per backend process.
 *  - Snapshot state is persisted in Postgres so restarts do not replay all
 *    historical positions.
 *  - The first poll for a leader BASELINES current positions only. This avoids
 *    mirroring stale positions that were already open before the follower
 *    enabled automation.
 */

import { and, eq } from "drizzle-orm";
import config from "../config.js";
import db from "../db/index.js";
import {
  copySubscriptions,
  followerWallets,
  leaderSnapshots,
  mirrorExecutions,
  type CopySubscriptionRow,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { closePosition, placeMarketOrder } from "../phoenix/order-service.js";
import { fetchLeaderPositions } from "../phoenix/trader-state.js";
import {
  normalizeCopySettings,
  type CopySettings,
  type LeaderPosition,
} from "../phoenix/types.js";
import { recordCopyAttribution } from "./attribution.js";
import { detectPositionChanges, type PositionChange } from "./diff.js";

const log = logger.child({ module: "copy-orchestrator" });

/**
 * Shared, mutable copy-points ledger for a single sync tick. Points are a
 * GLOBAL per-follower balance (stored on follower_wallets), so a follower that
 * copies several leaders draws opens from one shared pool. The ledger is loaded
 * once per tick and decremented in-memory + persisted as opens are mirrored.
 */
type PointsLedger = Map<string, number>;

export class CopyOrchestrator {
  private static instance: CopyOrchestrator | null = null;
  private interval: NodeJS.Timeout | null = null;
  private isTicking = false;

  static getInstance(): CopyOrchestrator {
    if (!CopyOrchestrator.instance) {
      CopyOrchestrator.instance = new CopyOrchestrator();
    }
    return CopyOrchestrator.instance;
  }

  /** Start the polling loop and do one immediate sync. */
  async start(): Promise<void> {
    if (this.interval) return;
    await this.syncNow();
    this.interval = setInterval(() => {
      void this.syncNow();
    }, config.LEADER_POLL_INTERVAL_MS);
    log.info({ intervalMs: config.LEADER_POLL_INTERVAL_MS }, "orchestrator started");
  }

  /** Stop the background loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info("orchestrator stopped");
    }
  }

  /** Trigger one sync immediately; no-op if the previous tick is still running. */
  async syncNow(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      const rows = await db
        .select()
        .from(copySubscriptions)
        .where(eq(copySubscriptions.status, "active"));

      if (rows.length === 0) {
        return;
      }

      // Load each follower's GLOBAL points balance once for this tick.
      const ledger: PointsLedger = new Map();
      const followerSet = new Set(rows.map((r) => r.followerWallet));
      const followerRows = await db.select().from(followerWallets);
      for (const fw of followerRows) {
        if (followerSet.has(fw.followerWallet)) {
          ledger.set(fw.followerWallet, fw.points);
        }
      }

      const grouped = new Map<string, CopySubscriptionRow[]>();
      for (const row of rows) {
        grouped.set(row.leaderWallet, [...(grouped.get(row.leaderWallet) ?? []), row]);
      }

      for (const [leaderWallet, subscriptions] of grouped.entries()) {
        await this.processLeader(leaderWallet, subscriptions, ledger);
      }
    } catch (err) {
      log.error({ err }, "sync tick failed");
    } finally {
      this.isTicking = false;
    }
  }

  private async processLeader(
    leaderWallet: string,
    subscriptions: CopySubscriptionRow[],
    ledger: PointsLedger
  ): Promise<void> {
    const currentPositions = await fetchLeaderPositions(leaderWallet);
    const snapshotRows = await db
      .select()
      .from(leaderSnapshots)
      .where(eq(leaderSnapshots.leaderWallet, leaderWallet))
      .limit(1);
    const previousPositions = (snapshotRows[0]?.positions as LeaderPosition[] | undefined) ?? [];

    if (snapshotRows.length === 0) {
      await this.upsertLeaderSnapshot(leaderWallet, currentPositions);
      log.info(
        { leaderWallet, positions: currentPositions.length },
        "leader baseline snapshot created"
      );
      return;
    }

    const changes = detectPositionChanges(previousPositions, currentPositions);
    if (changes.length > 0) {
      log.info({ leaderWallet, changes: changes.length }, "leader changes detected");
    }

    for (const change of changes) {
      for (const subscription of subscriptions) {
        await this.mirrorChange(subscription, change, ledger);
      }
    }

    await this.upsertLeaderSnapshot(leaderWallet, currentPositions);
  }

  private async mirrorChange(
    subscription: CopySubscriptionRow,
    change: PositionChange,
    ledger: PointsLedger
  ): Promise<void> {
    const settings = normalizeCopySettings(subscription.settings as CopySettings);
    const follower = subscription.followerWallet;

    if (change.type === "closed") {
      const result = await closePosition({
        privyWalletId: subscription.privyWalletId,
        authority: subscription.followerWallet,
        symbol: change.market,
        positionSide: change.side,
        sizeBase: change.position.size,
      });

      await this.recordExecution({
        subscription,
        change,
        side: change.side === "long" ? "sell" : "buy",
        quantity: change.position.size,
        notionalUsdc: 0,
        success: result.success,
        txSignature: result.txSignature,
        error: result.error,
      });
      return;
    }

    const pointsRemaining = ledger.get(follower) ?? 0;
    if (pointsRemaining <= 0) {
      await this.recordExecution({
        subscription,
        change,
        side: change.side === "long" ? "buy" : "sell",
        quantity: 0,
        notionalUsdc: settings.copyUSDC,
        success: false,
        error: "Out of copy points",
      });
      return;
    }

    const openSide = change.side === "long" ? "buy" : "sell";
    const entryPrice = change.position.entryPrice > 0 ? change.position.entryPrice : 1;
    const quantity = settings.copyUSDC / entryPrice;
    const stopLoss =
      change.position.entryPrice > 0
        ? change.position.entryPrice *
          (change.side === "long"
            ? 1 - settings.stopLossRatio
            : 1 + settings.stopLossRatio)
        : undefined;
    const transferMicro = Math.round(settings.copyUSDC * 1e6);

    const result = await placeMarketOrder({
      privyWalletId: subscription.privyWalletId,
      authority: subscription.followerWallet,
      symbol: change.market,
      side: openSide,
      quantity,
      transferAmountUsdc: transferMicro,
      stopLossPrice: stopLoss,
      slippageBps: Math.round(settings.maxSlippage * 10000),
    });

    await this.recordExecution({
      subscription,
      change,
      side: openSide,
      quantity,
      notionalUsdc: settings.copyUSDC,
      success: result.success,
      txSignature: result.txSignature,
      error: result.error,
    });

    if (!result.success) {
      return;
    }

    const next = pointsRemaining - 1;
    ledger.set(follower, next);
    await db
      .update(followerWallets)
      .set({
        points: next,
        updatedAt: new Date(),
      })
      .where(eq(followerWallets.followerWallet, follower));

    await recordCopyAttribution({
      walletAddress: subscription.followerWallet,
      broadcasterAddress: subscription.leaderWallet,
      market: change.market,
      side: openSide,
      notionalUsdc: settings.copyUSDC,
      eventType: change.type,
    });
  }

  private async recordExecution(params: {
    subscription: CopySubscriptionRow;
    change: PositionChange;
    side: string;
    quantity: number;
    notionalUsdc: number;
    success: boolean;
    txSignature?: string;
    error?: string;
  }): Promise<void> {
    await db.insert(mirrorExecutions).values({
      followerWallet: params.subscription.followerWallet,
      leaderWallet: params.subscription.leaderWallet,
      market: params.change.market,
      changeType: params.change.type,
      side: params.side,
      quantity: params.quantity,
      notionalUsdc: params.notionalUsdc,
      success: params.success,
      txSignature: params.txSignature,
      error: params.error,
    });
  }

  /** Persist the latest open-position snapshot for a leader. */
  async upsertLeaderSnapshot(
    leaderWallet: string,
    positions: LeaderPosition[]
  ): Promise<void> {
    await db
      .insert(leaderSnapshots)
      .values({
        leaderWallet,
        positions,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: leaderSnapshots.leaderWallet,
        set: {
          positions,
          updatedAt: new Date(),
        },
      });
  }

  /** Clear a leader snapshot once nobody actively follows them anymore. */
  async clearLeaderSnapshotIfUnused(leaderWallet: string): Promise<void> {
    const remaining = await db
      .select({ id: copySubscriptions.id })
      .from(copySubscriptions)
      .where(
        and(
          eq(copySubscriptions.leaderWallet, leaderWallet),
          eq(copySubscriptions.status, "active")
        )
      )
      .limit(1);

    if (remaining.length === 0) {
      await db.delete(leaderSnapshots).where(eq(leaderSnapshots.leaderWallet, leaderWallet));
    }
  }
}

export const orchestrator = CopyOrchestrator.getInstance();
export default orchestrator;
