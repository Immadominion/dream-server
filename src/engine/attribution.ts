/**
 * Copy attribution — records broadcaster earnings directly in Postgres when a
 * copier's mirror trade executes. Non-fatal: a mirror succeeds even if the
 * broadcaster row is missing or attribution fails.
 */

import { eq, sql } from "drizzle-orm";
import config from "../config.js";
import db from "../db/index.js";
import {
    broadcasterCopiers,
    broadcasterEarnings,
    broadcasters,
} from "../db/schema.js";
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
    try {
        const [broadcaster] = await db
            .select()
            .from(broadcasters)
            .where(eq(broadcasters.address, event.broadcasterAddress))
            .limit(1);

        if (!broadcaster?.isActive) {
            log.debug({ broadcaster: event.broadcasterAddress }, "broadcaster not found or inactive");
            return;
        }

        const builderFeeUsd = event.notionalUsdc * (config.BUILDER_FEE_BPS / 10_000);
        const earnedUsd = builderFeeUsd * (broadcaster.revenueShareBps / 10_000);
        const now = new Date();
        // Truncate copier address to 8+4 chars for privacy in earnings history.
        const truncatedCopier =
            event.walletAddress.length > 12
                ? `${event.walletAddress.slice(0, 8)}...${event.walletAddress.slice(-4)}`
                : event.walletAddress;

        await db.transaction(async (tx) => {
            // Upsert copier tracking row.
            await tx
                .insert(broadcasterCopiers)
                .values({
                    broadcasterAddress: event.broadcasterAddress,
                    copierAddress: event.walletAddress,
                    lastSeenAt: now,
                })
                .onConflictDoUpdate({
                    target: [broadcasterCopiers.broadcasterAddress, broadcasterCopiers.copierAddress],
                    set: { lastSeenAt: now },
                });

            // Recount unique copiers from the tracking table.
            const [{ count }] = await tx
                .select({ count: sql<number>`count(*)::int` })
                .from(broadcasterCopiers)
                .where(eq(broadcasterCopiers.broadcasterAddress, event.broadcasterAddress));

            // Update aggregate stats on the broadcaster row.
            await tx
                .update(broadcasters)
                .set({
                    fillsCount: sql`${broadcasters.fillsCount} + 1`,
                    volumeUsd: sql`${broadcasters.volumeUsd} + ${event.notionalUsdc}`,
                    lifetimeUsd: sql`${broadcasters.lifetimeUsd} + ${earnedUsd}`,
                    claimableUsd: sql`${broadcasters.claimableUsd} + ${earnedUsd}`,
                    copierCount: count,
                    updatedAt: now,
                })
                .where(eq(broadcasters.address, event.broadcasterAddress));

            // Append earnings history row.
            await tx.insert(broadcasterEarnings).values({
                broadcasterAddress: event.broadcasterAddress,
                type: "copy",
                copierAddress: truncatedCopier,
                market: event.market.slice(0, 24),
                side: event.side.slice(0, 8),
                notionalUsd: event.notionalUsdc,
                builderFeeUsd,
                earnedUsd,
                createdAt: now,
            });
        });

        log.debug(
            { broadcaster: event.broadcasterAddress, earnedUsd, market: event.market },
            "attribution recorded"
        );
    } catch (err) {
        log.warn({ err, market: event.market }, "attribution failed (non-fatal)");
    }
}

