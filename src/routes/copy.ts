import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import config from "../config.js";
import db from "../db/index.js";
import { copySubscriptions, followerWallets } from "../db/schema.js";
import { orchestrator } from "../engine/orchestrator.js";
import {
    PointsCreditError,
    verifyAndCreditPoints,
} from "../engine/points-credit.js";
import { walletAuth, type WalletAuthEnv } from "../middleware/wallet-auth.js";
import {
    defaultCopySettings,
    normalizeCopySettings,
} from "../phoenix/types.js";

const copy = new Hono<WalletAuthEnv>();
copy.use("*", walletAuth);

/**
 * Free copy-points granted once, the first time a follower registers the server
 * signer. Points are a GLOBAL per-follower balance (Postgres is the source of
 * truth); opens consume one point across all followed leaders, closes are free.
 */
const FREE_POINTS_GRANT = 500;

const registerSignerSchema = z.object({
    privyWalletId: z.string().min(1),
});

const enableSchema = z.object({
    leaderWallet: z.string().min(1),
    privyWalletId: z.string().min(1).optional(),
    settings: z
        .object({
            copyUSDC: z.number().positive().optional(),
            maxSlippage: z.number().nonnegative().optional(),
            stopLossRatio: z.number().nonnegative().optional(),
        })
        .optional(),
});

const disableSchema = z.object({
    leaderWallet: z.string().min(1),
});

const creditSchema = z.object({
    txSignature: z.string().min(1),
});

/**
 * Tells the client which signer to attach on-device via Privy `addSigner`.
 * The client must attach this signer (scoped by the Phoenix policy) and then
 * call /register-signer so the server can sign mirrors while offline.
 */
copy.get("/signer-config", (c) => {
    return c.json({
        signerId: config.PRIVY_SIGNER_ID,
        policyIds: config.PRIVY_PHOENIX_POLICY_ID
            ? [config.PRIVY_PHOENIX_POLICY_ID]
            : [],
        policyScope: "phoenix-only",
    });
});

copy.get("/subscriptions", async (c) => {
    const walletAddress = c.get("walletAddress");
    const rows = await db
        .select()
        .from(copySubscriptions)
        .where(eq(copySubscriptions.followerWallet, walletAddress));

    return c.json({ subscriptions: rows });
});

/** Current global copy-points balance for the authenticated follower. */
copy.get("/points", async (c) => {
    const walletAddress = c.get("walletAddress");
    const rows = await db
        .select({ points: followerWallets.points })
        .from(followerWallets)
        .where(eq(followerWallets.followerWallet, walletAddress))
        .limit(1);

    return c.json({ points: rows[0]?.points ?? 0 });
});

/**
 * Credit copy-points from a verified on-chain SOL payment. The server fully
 * re-verifies the payment (amount, source, destination, finality) and is the
 * sole authority on how many points are granted — the client only supplies the
 * tx signature. Idempotent per signature (replay-safe).
 */
copy.post("/points/credit", zValidator("json", creditSchema), async (c) => {
    const walletAddress = c.get("walletAddress");
    const { txSignature } = c.req.valid("json");

    try {
        const result = await verifyAndCreditPoints({
            txSignature,
            followerWallet: walletAddress,
        });
        return c.json({ ok: true, ...result });
    } catch (err) {
        if (err instanceof PointsCreditError) {
            return c.json({ error: err.message }, err.statusCode);
        }
        throw err;
    }
});

copy.post("/register-signer", zValidator("json", registerSignerSchema), async (c) => {
    const walletAddress = c.get("walletAddress");
    const { privyWalletId } = c.req.valid("json");

    // Grant the free points pool only the first time this follower registers.
    const existing = await db
        .select({ points: followerWallets.points })
        .from(followerWallets)
        .where(eq(followerWallets.followerWallet, walletAddress))
        .limit(1);
    const isFirstRegistration = existing.length === 0;

    await db
        .insert(followerWallets)
        .values({
            followerWallet: walletAddress,
            privyWalletId,
            signerStatus: "active",
            points: FREE_POINTS_GRANT,
            lastConsentAt: new Date(),
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: followerWallets.followerWallet,
            set: {
                privyWalletId,
                signerStatus: "active",
                lastConsentAt: new Date(),
                updatedAt: new Date(),
            },
        });

    const points = isFirstRegistration
        ? FREE_POINTS_GRANT
        : existing[0]?.points ?? 0;

    return c.json({
        ok: true,
        walletAddress,
        privyWalletId,
        points,
        // Returned so the mobile consent flow knows which policies to attach.
        policyScope: "phoenix-only",
    });
});

copy.post("/enable", zValidator("json", enableSchema), async (c) => {
    const walletAddress = c.get("walletAddress");
    const body = c.req.valid("json");
    const settings = normalizeCopySettings(body.settings ?? defaultCopySettings);

    const existingSigner = await db
        .select()
        .from(followerWallets)
        .where(
            and(
                eq(followerWallets.followerWallet, walletAddress),
                eq(followerWallets.signerStatus, "active")
            )
        )
        .limit(1);

    const privyWalletId = body.privyWalletId ?? existingSigner[0]?.privyWalletId;
    if (!privyWalletId) {
        return c.json(
            {
                error:
                    "No active signer registration found. Call /register-signer first or include privyWalletId.",
            },
            400
        );
    }

    if (body.privyWalletId) {
        await db
            .insert(followerWallets)
            .values({
                followerWallet: walletAddress,
                privyWalletId,
                signerStatus: "active",
                lastConsentAt: new Date(),
                updatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: followerWallets.followerWallet,
                set: {
                    privyWalletId,
                    signerStatus: "active",
                    updatedAt: new Date(),
                },
            });
    }

    await db
        .insert(copySubscriptions)
        .values({
            followerWallet: walletAddress,
            privyWalletId,
            leaderWallet: body.leaderWallet,
            settings,
            status: "active",
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: [copySubscriptions.followerWallet, copySubscriptions.leaderWallet],
            set: {
                privyWalletId,
                settings,
                status: "active",
                updatedAt: new Date(),
            },
        });

    await orchestrator.syncNow();

    return c.json({
        ok: true,
        leaderWallet: body.leaderWallet,
        settings,
    });
});

copy.post("/disable", zValidator("json", disableSchema), async (c) => {
    const walletAddress = c.get("walletAddress");
    const { leaderWallet } = c.req.valid("json");

    await db
        .update(copySubscriptions)
        .set({
            status: "paused",
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(copySubscriptions.followerWallet, walletAddress),
                eq(copySubscriptions.leaderWallet, leaderWallet)
            )
        );

    await orchestrator.clearLeaderSnapshotIfUnused(leaderWallet);
    await orchestrator.syncNow();

    return c.json({ ok: true, leaderWallet, status: "paused" });
});

export default copy;
