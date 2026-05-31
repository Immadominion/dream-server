/**
 * Broadcaster marketplace routes.
 *
 * Public:
 *   GET  /v1/broadcasters          — paginated, sorted broadcaster list
 *
 * Authenticated (wallet signature required):
 *   GET  /v1/broadcasters/me       — own profile
 *   GET  /v1/broadcasters/earnings — earnings history + stats
 *   POST /v1/broadcasters/register — register or update profile
 *   POST /v1/broadcasters/attribution — record a copy-trade attribution
 *   POST /v1/broadcasters/payout   — request payout of claimable balance
 */

import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import config from "../config.js";
import db from "../db/index.js";
import {
    broadcasterCopiers,
    broadcasterEarnings,
    broadcasterPayouts,
    broadcasters,
} from "../db/schema.js";
import { walletAuth, type WalletAuthEnv } from "../middleware/wallet-auth.js";
import { logger } from "../logger.js";
import { sendTelegram } from "./analytics.js";

const log = logger.child({ module: "broadcasters" });

const EARNINGS_PAGE_SIZE = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeDisplayName(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim().replace(/[<>&"']/g, "").slice(0, 40);
    return s.length >= 1 ? s : null;
}

function sanitizeStrategy(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    return v.trim().slice(0, 120) || undefined;
}

function sanitizeTwitter(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const s = v.trim().replace(/^@/, "").slice(0, 40);
    return s || undefined;
}

function safeFixed(n: number, dp: number): number {
    return Number(n.toFixed(dp));
}

// ── Public router (no auth) ──────────────────────────────────────────────────

export const broadcastersPublic = new Hono();

broadcastersPublic.get("/", async (c) => {
    const limit = Math.min(
        Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
        100
    );
    const sort = (c.req.query("sort") ?? "earnings").toLowerCase();

    const rows = await db
        .select()
        .from(broadcasters)
        .where(eq(broadcasters.isActive, true))
        .orderBy(
            sort === "copiers"
                ? desc(broadcasters.copierCount)
                : sort === "volume"
                    ? desc(broadcasters.volumeUsd)
                    : sort === "newest"
                        ? desc(broadcasters.createdAt)
                        : desc(broadcasters.lifetimeUsd)
        )
        .limit(limit);

    const result = rows.map((r) => ({
        address: r.address,
        displayName: r.displayName,
        strategy: r.strategy ?? undefined,
        twitter: r.twitter ?? undefined,
        copierCount: r.copierCount,
        lifetimeUsd: safeFixed(r.lifetimeUsd, 6),
        volumeUsd: safeFixed(r.volumeUsd, 2),
        fillsCount: r.fillsCount,
        revenueShareBps: r.revenueShareBps,
    }));

    return c.json({ broadcasters: result, total: result.length });
});

// ── Authenticated router ─────────────────────────────────────────────────────

export const broadcastersAuth = new Hono<WalletAuthEnv>();
broadcastersAuth.use("*", walletAuth);

broadcastersAuth.get("/me", async (c) => {
    const address = c.get("walletAddress");
    const [broadcaster] = await db
        .select()
        .from(broadcasters)
        .where(and(eq(broadcasters.address, address), eq(broadcasters.isActive, true)))
        .limit(1);

    if (!broadcaster) return c.json({ error: "Broadcaster not found" }, 404);

    return c.json({ broadcaster: sanitizeForClient(broadcaster) });
});

broadcastersAuth.get("/earnings", async (c) => {
    const address = c.get("walletAddress");
    const [broadcaster] = await db
        .select()
        .from(broadcasters)
        .where(and(eq(broadcasters.address, address), eq(broadcasters.isActive, true)))
        .limit(1);

    if (!broadcaster) return c.json({ error: "Broadcaster not found" }, 404);

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const history = await db
        .select()
        .from(broadcasterEarnings)
        .where(eq(broadcasterEarnings.broadcasterAddress, address))
        .orderBy(desc(broadcasterEarnings.createdAt))
        .limit(EARNINGS_PAGE_SIZE);

    const payouts = await db
        .select()
        .from(broadcasterPayouts)
        .where(eq(broadcasterPayouts.broadcasterAddress, address))
        .orderBy(desc(broadcasterPayouts.createdAt));

    const copyEvents = history.filter((e) => e.type === "copy");
    const since = (ms: number) =>
        copyEvents
            .filter((e) => now - e.createdAt.getTime() <= ms)
            .reduce((sum, e) => sum + (e.earnedUsd || 0), 0);

    return c.json({
        stats: {
            lifetimeUsd: safeFixed(broadcaster.lifetimeUsd, 6),
            claimableUsd: safeFixed(broadcaster.claimableUsd, 6),
            paidOutUsd: safeFixed(broadcaster.paidOutUsd, 6),
            last7dUsd: safeFixed(since(7 * DAY), 6),
            last30dUsd: safeFixed(since(30 * DAY), 6),
            copierCount: broadcaster.copierCount,
            fillsCount: broadcaster.fillsCount,
            volumeUsd: safeFixed(broadcaster.volumeUsd, 2),
            revenueShareBps: broadcaster.revenueShareBps,
            payoutMinUsd: config.PAYOUT_MIN_USD,
        },
        history: history.map((e) => ({
            ts: e.createdAt.getTime(),
            type: e.type,
            copier: e.copierAddress ?? undefined,
            market: e.market ?? undefined,
            side: e.side ?? undefined,
            notionalUsd: e.notionalUsd,
            builderFeeUsd: e.builderFeeUsd,
            earnedUsd: e.earnedUsd,
        })),
        payouts: payouts.map((p) => ({
            ts: p.createdAt.getTime(),
            amountUsd: p.amountUsd,
            status: p.status,
        })),
    });
});

const registerSchema = z.object({
    displayName: z.string().min(1).max(40),
    strategy: z.string().max(120).optional(),
    twitter: z.string().max(40).optional(),
});

broadcastersAuth.post("/register", zValidator("json", registerSchema), async (c) => {
    const address = c.get("walletAddress");
    const body = c.req.valid("json");

    const displayName = sanitizeDisplayName(body.displayName);
    if (!displayName) return c.json({ error: "Invalid displayName" }, 400);

    const now = new Date();
    const [current] = await db
        .select()
        .from(broadcasters)
        .where(eq(broadcasters.address, address))
        .limit(1);

    await db
        .insert(broadcasters)
        .values({
            address,
            displayName,
            strategy: sanitizeStrategy(body.strategy),
            twitter: sanitizeTwitter(body.twitter),
            revenueShareBps: config.BROADCASTER_SHARE_BPS,
            isActive: true,
            createdAt: current?.createdAt ?? now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: broadcasters.address,
            set: {
                displayName,
                strategy: sanitizeStrategy(body.strategy),
                twitter: sanitizeTwitter(body.twitter),
                isActive: true,
                updatedAt: now,
            },
        });

    const [updated] = await db
        .select()
        .from(broadcasters)
        .where(eq(broadcasters.address, address))
        .limit(1);

    return c.json({ ok: true, broadcaster: sanitizeForClient(updated!) });
});

const attributionSchema = z.object({
    broadcasterAddress: z.string().min(1),
    market: z.string().max(24).optional().default(""),
    side: z.string().max(8).optional().default(""),
    notionalUsdc: z.number().nonnegative(),
    eventType: z.enum(["open", "opened", "increase", "increased"]),
});

broadcastersAuth.post(
    "/attribution",
    zValidator("json", attributionSchema),
    async (c) => {
        const copierAddress = c.get("walletAddress");
        const body = c.req.valid("json");

        if (body.broadcasterAddress === copierAddress) {
            return c.json({ error: "Self attribution is not allowed" }, 400);
        }

        const [broadcaster] = await db
            .select()
            .from(broadcasters)
            .where(
                and(
                    eq(broadcasters.address, body.broadcasterAddress),
                    eq(broadcasters.isActive, true)
                )
            )
            .limit(1);

        if (!broadcaster) return c.json({ error: "Broadcaster not found" }, 404);

        const builderFeeUsd = body.notionalUsdc * (config.BUILDER_FEE_BPS / 10_000);
        const earnedUsd = builderFeeUsd * (broadcaster.revenueShareBps / 10_000);
        const now = new Date();
        const truncatedCopier =
            copierAddress.length > 12
                ? `${copierAddress.slice(0, 8)}...${copierAddress.slice(-4)}`
                : copierAddress;

        await db.transaction(async (tx) => {
            await tx
                .insert(broadcasterCopiers)
                .values({
                    broadcasterAddress: body.broadcasterAddress,
                    copierAddress,
                    lastSeenAt: now,
                })
                .onConflictDoUpdate({
                    target: [broadcasterCopiers.broadcasterAddress, broadcasterCopiers.copierAddress],
                    set: { lastSeenAt: now },
                });

            const [{ count }] = await tx
                .select({ count: sql<number>`count(*)::int` })
                .from(broadcasterCopiers)
                .where(eq(broadcasterCopiers.broadcasterAddress, body.broadcasterAddress));

            await tx
                .update(broadcasters)
                .set({
                    fillsCount: sql`${broadcasters.fillsCount} + 1`,
                    volumeUsd: sql`${broadcasters.volumeUsd} + ${body.notionalUsdc}`,
                    lifetimeUsd: sql`${broadcasters.lifetimeUsd} + ${earnedUsd}`,
                    claimableUsd: sql`${broadcasters.claimableUsd} + ${earnedUsd}`,
                    copierCount: count,
                    updatedAt: now,
                })
                .where(eq(broadcasters.address, body.broadcasterAddress));

            await tx.insert(broadcasterEarnings).values({
                broadcasterAddress: body.broadcasterAddress,
                type: "copy",
                copierAddress: truncatedCopier,
                market: body.market,
                side: body.side,
                notionalUsd: body.notionalUsdc,
                builderFeeUsd,
                earnedUsd,
                createdAt: now,
            });
        });

        // Refresh for accurate aggregates in response.
        const [updated] = await db
            .select()
            .from(broadcasters)
            .where(eq(broadcasters.address, body.broadcasterAddress))
            .limit(1);

        return c.json({
            ok: true,
            broadcasterAddress: body.broadcasterAddress,
            builderFeeUsd: safeFixed(builderFeeUsd, 6),
            earnedUsd: safeFixed(earnedUsd, 6),
            lifetimeUsd: safeFixed(updated!.lifetimeUsd, 6),
            claimableUsd: safeFixed(updated!.claimableUsd, 6),
            copierCount: updated!.copierCount,
        });
    }
);

broadcastersAuth.post("/payout", async (c) => {
    const address = c.get("walletAddress");
    const [broadcaster] = await db
        .select()
        .from(broadcasters)
        .where(and(eq(broadcasters.address, address), eq(broadcasters.isActive, true)))
        .limit(1);

    if (!broadcaster) return c.json({ error: "Broadcaster not found" }, 404);

    const amount = safeFixed(broadcaster.claimableUsd, 6);
    if (amount < config.PAYOUT_MIN_USD) {
        return c.json(
            { error: "Below minimum payout", claimableUsd: amount, payoutMinUsd: config.PAYOUT_MIN_USD },
            400
        );
    }

    const now = new Date();

    await db.transaction(async (tx) => {
        await tx.insert(broadcasterPayouts).values({
            broadcasterAddress: address,
            amountUsd: amount,
            status: "requested",
            createdAt: now,
        });

        await tx.insert(broadcasterEarnings).values({
            broadcasterAddress: address,
            type: "payout",
            earnedUsd: -amount,
            createdAt: now,
        });

        await tx
            .update(broadcasters)
            .set({
                claimableUsd: 0,
                paidOutUsd: sql`${broadcasters.paidOutUsd} + ${amount}`,
                updatedAt: now,
            })
            .where(eq(broadcasters.address, address));
    });

    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
        void sendTelegram(
            `💸 *Payout requested*\n${broadcaster.displayName} \`${shortAddr(address)}\`\n` +
            `Amount: $${amount.toFixed(2)} USDC`
        );
    }

    const [updated] = await db
        .select()
        .from(broadcasters)
        .where(eq(broadcasters.address, address))
        .limit(1);

    log.info({ broadcaster: address, amountUsd: amount }, "payout requested");

    return c.json({
        ok: true,
        amountUsd: amount,
        paidOutUsd: safeFixed(updated!.paidOutUsd, 6),
        claimableUsd: 0,
    });
});

// ── Private helpers ───────────────────────────────────────────────────────────

function sanitizeForClient(r: typeof broadcasters.$inferSelect) {
    return {
        address: r.address,
        displayName: r.displayName,
        strategy: r.strategy ?? undefined,
        twitter: r.twitter ?? undefined,
        copierCount: r.copierCount,
        lifetimeUsd: safeFixed(r.lifetimeUsd, 6),
        claimableUsd: safeFixed(r.claimableUsd, 6),
        paidOutUsd: safeFixed(r.paidOutUsd, 6),
        volumeUsd: safeFixed(r.volumeUsd, 2),
        fillsCount: r.fillsCount,
        revenueShareBps: r.revenueShareBps,
        isActive: r.isActive,
        createdAt: r.createdAt.getTime(),
    };
}

function shortAddr(addr: string): string {
    return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}
