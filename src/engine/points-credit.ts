/**
 * Secure copy-points top-up crediting.
 *
 * Flow: the client pays SOL to the Dream treasury on-chain, then sends us the
 * tx signature. We verify the payment fully on-chain before crediting Postgres
 * points — the client never tells us how many points to grant.
 *
 * Guarantees:
 *  - Replay protection: each tx signature can only be credited once (the
 *    point_purchases primary key + a pre-check).
 *  - Amount integrity: points come from a fixed tier table matched against the
 *    actual lamports transferred to the treasury, not from client input.
 *  - Ownership: the paying source must be the authenticated follower wallet and
 *    the destination must be the configured treasury.
 *  - Finality: the tx must be confirmed on-chain with no error.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { eq, sql } from "drizzle-orm";
import config from "../config.js";
import db from "../db/index.js";
import { followerWallets, pointPurchases } from "../db/schema.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "points-credit" });

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Paid tiers. MUST mirror the client's `CreditTier.tiers`. Pricing is
 * non-linear (volume discount) so we match the exact lamports paid to a tier
 * rather than deriving points from a flat rate.
 */
const TIERS: ReadonlyArray<{ lamports: number; credits: number }> = [
    { lamports: Math.round(0.02 * LAMPORTS_PER_SOL), credits: 10 },
    { lamports: Math.round(0.08 * LAMPORTS_PER_SOL), credits: 50 },
    { lamports: Math.round(0.25 * LAMPORTS_PER_SOL), credits: 200 },
];

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

export class PointsCreditError extends Error {
    constructor(
        message: string,
        readonly statusCode: 400 | 402 | 404 | 409 = 400
    ) {
        super(message);
        this.name = "PointsCreditError";
    }
}

export interface CreditResult {
    points: number;
    credited: number;
    alreadyProcessed: boolean;
}

/**
 * Verify an on-chain SOL payment and credit the follower's global copy-points
 * balance. Idempotent: replaying the same signature returns the current balance
 * without double-crediting.
 */
export async function verifyAndCreditPoints(params: {
    txSignature: string;
    followerWallet: string;
}): Promise<CreditResult> {
    const { txSignature, followerWallet } = params;

    if (!config.DREAM_TREASURY_ADDRESS) {
        throw new PointsCreditError("Treasury is not configured", 400);
    }

    // 1. Replay guard — never credit the same signature twice.
    const existing = await db
        .select({ tx: pointPurchases.txSignature })
        .from(pointPurchases)
        .where(eq(pointPurchases.txSignature, txSignature))
        .limit(1);
    if (existing.length > 0) {
        const points = await currentBalance(followerWallet);
        return { points, credited: 0, alreadyProcessed: true };
    }

    // 2. Validate the wallet inputs are real public keys before any RPC call.
    let treasury: PublicKey;
    let follower: PublicKey;
    try {
        treasury = new PublicKey(config.DREAM_TREASURY_ADDRESS);
        follower = new PublicKey(followerWallet);
    } catch {
        throw new PointsCreditError("Invalid wallet address", 400);
    }

    // 3. Fetch + verify the transaction on-chain.
    const tx = await connection.getParsedTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
        throw new PointsCreditError("Transaction not found or not yet confirmed", 404);
    }
    if (tx.meta?.err) {
        throw new PointsCreditError("Transaction failed on-chain", 402);
    }

    // 4. Sum SOL transferred from the follower to the treasury.
    const lamports = sumTransferLamports(tx, follower, treasury);
    if (lamports <= 0) {
        throw new PointsCreditError(
            "No SOL transfer from this wallet to the treasury found in the transaction",
            402
        );
    }

    // 5. Match the exact amount to a known tier.
    const tier = TIERS.find((t) => t.lamports === lamports);
    if (!tier) {
        throw new PointsCreditError(
            `Payment amount (${lamports} lamports) does not match any credit tier`,
            402
        );
    }

    // 6. Atomically record the purchase + credit the balance. The point_purchases
    //    primary key is the final replay backstop against concurrent requests.
    const points = await db.transaction(async (tx2) => {
        await tx2.insert(pointPurchases).values({
            txSignature,
            followerWallet,
            credits: tier.credits,
            lamports,
        });

        const updated = await tx2
            .update(followerWallets)
            .set({
                points: sql`${followerWallets.points} + ${tier.credits}`,
                updatedAt: new Date(),
            })
            .where(eq(followerWallets.followerWallet, followerWallet))
            .returning({ points: followerWallets.points });

        if (updated.length === 0) {
            // No follower row yet — they must register the signer first.
            throw new PointsCreditError(
                "No follower registration found. Enable copy trading first.",
                404
            );
        }
        return updated[0]!.points;
    });

    log.info(
        { followerWallet, txSignature, lamports, credited: tier.credits, points },
        "copy points credited from verified payment"
    );

    return { points, credited: tier.credits, alreadyProcessed: false };
}

async function currentBalance(followerWallet: string): Promise<number> {
    const rows = await db
        .select({ points: followerWallets.points })
        .from(followerWallets)
        .where(eq(followerWallets.followerWallet, followerWallet))
        .limit(1);
    return rows[0]?.points ?? 0;
}

/**
 * Total lamports moved from `source` to `destination` via System Program
 * transfers in a parsed transaction.
 */
function sumTransferLamports(
    tx: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>,
    source: PublicKey,
    destination: PublicKey
): number {
    const src = source.toBase58();
    const dest = destination.toBase58();
    let total = 0;

    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
        if (!("parsed" in ix)) continue;
        if (ix.program !== "system") continue;
        const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
        if (parsed.type !== "transfer" && parsed.type !== "transferWithSeed") continue;
        const info = parsed.info ?? {};
        if (info.source !== src || info.destination !== dest) continue;
        const lamports = Number(info.lamports ?? 0);
        if (Number.isFinite(lamports) && lamports > 0) total += lamports;
    }

    return total;
}
