/**
 * Dream coins on Meteora Dynamic Bonding Curve (DBC).
 *
 * Model:
 *  - Dream is the DBC *partner*: one config account (created once by
 *    scripts/create-dream-dbc-config.ts) fixes the curve, fees and migration
 *    for every dream coin. Partner fees go to Dream's fee claimer.
 *  - The dream owner is the pool *creator*. The DBC program requires the
 *    creator to sign pool creation, so a coin can only ever be launched by the
 *    person with the need — nobody can launch "for" someone without consent.
 *    Creator trading fees (the larger share, set in the config) accrue to them.
 *  - The server never holds user keys. It builds transactions, partially signs
 *    only with the single-use mint keypair it just generated, and returns them
 *    for the user's wallet to sign and submit.
 *
 * After the curve completes, the pool migrates to DAMM v2. Swaps then route
 * through aggregators (Jupiter), and post-migration LP fees are claimed from
 * the position NFT the owner receives — both are out of scope for DBC calls,
 * and the API reports `graduated: true` so the app can link out.
 */

import {
    DynamicBondingCurveClient,
    SwapMode,
    U64_MAX,
    deriveDbcPoolAddress,
    getCurrentPoint,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import config from "../config.js";

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Compute-unit limits per transaction kind: ~1.5× measured usage against the
 * DBC program (launch 119.6k, buy 94.0k, sell 68.8k, claim 67.1k CU). Tight
 * limits make priority fees cheaper and help transactions land.
 */
const CU_LIMIT = { launch: 180_000, swap: 150_000, claim: 110_000 } as const;

export class CoinError extends Error {
    constructor(
        message: string,
        readonly statusCode: 400 | 404 | 409 | 422 | 503 = 422
    ) {
        super(message);
        this.name = "CoinError";
    }
}

export interface UnsignedTx {
    /** base64 wire transaction; may already carry the mint's signature. */
    transaction: string;
    lastValidBlockHeight: number;
}

export interface CoinStats {
    graduated: boolean;
    /** Bonding-curve progress toward migration, 0..1. */
    curveProgress: number;
    /** Owner's unclaimed trading fees in lamports (pre-migration). */
    ownerUnclaimedLamports: bigint;
    /** Owner's lifetime trading fees in lamports (claimed + unclaimed). */
    ownerLifetimeLamports: bigint;
}

let cachedClient: DynamicBondingCurveClient | null = null;
let cachedConnection: Connection | null = null;

export function connection(): Connection {
    cachedConnection ??= new Connection(config.SOLANA_RPC_URL, "confirmed");
    return cachedConnection;
}

function dbc(): DynamicBondingCurveClient {
    cachedClient ??= new DynamicBondingCurveClient(connection(), "confirmed");
    return cachedClient;
}

export function coinLaunchesEnabled(): boolean {
    return config.DREAM_DBC_CONFIG.length > 0;
}

function dreamConfigKey(): PublicKey {
    if (!coinLaunchesEnabled()) throw new CoinError("Coin launches are not enabled yet", 503);
    return new PublicKey(config.DREAM_DBC_CONFIG);
}

export function coinMetadataUri(mint: string): string {
    return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/dreams/coins/${mint}/metadata.json`;
}

/**
 * Add a priority fee + CU limit, set fee payer + blockhash, apply any
 * server-side signers, and serialize without requiring the user's signature.
 */
async function finalize(
    tx: Transaction,
    feePayer: PublicKey,
    computeUnits: number,
    signers: Keypair[] = []
): Promise<UnsignedTx> {
    const budget: Transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })
    );
    if (config.PRIORITY_FEE_MICROLAMPORTS > 0) {
        budget.add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.PRIORITY_FEE_MICROLAMPORTS })
        );
    }
    tx.instructions = [...budget.instructions, ...tx.instructions];

    const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
    if (signers.length > 0) tx.partialSign(...signers);

    return {
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        lastValidBlockHeight,
    };
}

/** Build the pool-creation tx for a dream coin. The owner pays and signs. */
export async function buildLaunchTx(params: {
    owner: string;
    name: string;
    symbol: string;
}): Promise<UnsignedTx & { mint: string; pool: string }> {
    const configKey = dreamConfigKey();
    const owner = new PublicKey(params.owner);
    const mint = Keypair.generate();
    const pool = deriveDbcPoolAddress(WSOL_MINT, mint.publicKey, configKey);

    const tx = await dbc().creator.createPool({
        name: params.name,
        symbol: params.symbol,
        uri: coinMetadataUri(mint.publicKey.toBase58()),
        payer: owner,
        poolCreator: owner,
        config: configKey,
        baseMint: mint.publicKey,
    });

    // The mint keypair signs here and is then dropped — it is single-use and
    // its only authority (initializing the mint) is consumed by this tx.
    const unsigned = await finalize(tx, owner, CU_LIMIT.launch, [mint]);
    return { ...unsigned, mint: mint.publicKey.toBase58(), pool: pool.toBase58() };
}

/**
 * Verify on-chain that [pool] exists, belongs to Dream's config, has
 * [owner] as creator and [mint] as base mint. This — not the client's word —
 * is what makes a launch "confirmed".
 */
export async function verifyLaunchedPool(params: { pool: string; mint: string; owner: string }): Promise<void> {
    const configKey = dreamConfigKey();
    const pool = await dbc().state.getPool(params.pool);
    if (!pool) throw new CoinError("Pool not found on-chain yet — try again in a few seconds", 409);

    if (!pool.poolState.config.equals(configKey)) throw new CoinError("Pool was not created with Dream's config");
    if (pool.poolState.creator.toBase58() !== params.owner) throw new CoinError("Pool creator is not the dream owner");
    if (pool.poolState.baseMint.toBase58() !== params.mint) throw new CoinError("Pool mint mismatch");
}

async function loadPool(poolAddress: string) {
    const pool = await dbc().state.getPool(poolAddress);
    if (!pool) throw new CoinError("Pool not found", 404);
    const poolConfig = await dbc().state.getPoolConfig(pool.poolState.config);
    if (!poolConfig) throw new CoinError("Pool config not found", 404);
    return { pool, poolConfig };
}

/** Build a buy (SOL → coin) or sell (coin → SOL) on the bonding curve. */
export async function buildSwapTx(params: {
    pool: string;
    owner: string;
    side: "buy" | "sell";
    amountIn: bigint;
    slippageBps: number;
}): Promise<UnsignedTx & { expectedOut: string; minimumOut: string }> {
    const { pool, poolConfig } = await loadPool(params.pool);
    if (pool.poolState.isMigrated === 1) {
        throw new CoinError("This coin has graduated — trade it on Jupiter", 409);
    }

    const owner = new PublicKey(params.owner);
    const swapBaseForQuote = params.side === "sell";
    const amountIn = new BN(params.amountIn.toString());
    const currentPoint = await getCurrentPoint(connection(), poolConfig.activationType);

    const quote = dbc().pool.swapQuote2({
        virtualPool: pool,
        config: poolConfig,
        swapBaseForQuote,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
        slippageBps: params.slippageBps,
        swapMode: SwapMode.ExactIn,
        amountIn,
    });
    const minimumOut = quote.minimumAmountOut;
    if (!minimumOut || minimumOut.isZero()) throw new CoinError("Amount too small to trade", 400);

    const tx = await dbc().pool.swap2({
        owner,
        pool: new PublicKey(params.pool),
        swapBaseForQuote,
        referralTokenAccount: null,
        swapMode: SwapMode.ExactIn,
        amountIn,
        minimumAmountOut: minimumOut,
    });

    const unsigned = await finalize(tx, owner, CU_LIMIT.swap);
    return { ...unsigned, expectedOut: quote.outputAmount.toString(), minimumOut: minimumOut.toString() };
}

/** Build the owner's creator-fee claim (pre-migration fees, paid in SOL). */
export async function buildClaimTx(params: { pool: string; owner: string }): Promise<UnsignedTx> {
    const { pool } = await loadPool(params.pool);
    const owner = new PublicKey(params.owner);
    if (!pool.poolState.creator.equals(owner)) throw new CoinError("Only the dream owner can claim", 400);

    const tx = await dbc().creator.claimCreatorTradingFee({
        creator: owner,
        payer: owner,
        pool: new PublicKey(params.pool),
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
    });
    return finalize(tx, owner, CU_LIMIT.claim);
}

// Coin stats hit RPC several times; cache briefly so feed views stay cheap.
const STATS_TTL_MS = 30_000;
const statsCache = new Map<string, { at: number; value: CoinStats }>();

export async function getCoinStats(poolAddress: string): Promise<CoinStats> {
    const hit = statsCache.get(poolAddress);
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;

    const { pool } = await loadPool(poolAddress);
    const [progress, breakdown] = await Promise.all([
        dbc().state.getPoolQuoteTokenCurveProgress(poolAddress),
        dbc().state.getPoolFeeBreakdown(poolAddress),
    ]);

    const value: CoinStats = {
        graduated: pool.poolState.isMigrated === 1,
        curveProgress: progress,
        ownerUnclaimedLamports: BigInt(breakdown.creator.unclaimedQuoteFee.toString()),
        ownerLifetimeLamports: BigInt(breakdown.creator.totalQuoteFee.toString()),
    };
    statsCache.set(poolAddress, { at: Date.now(), value });
    if (statsCache.size > 5_000) statsCache.clear();
    return value;
}

export function invalidateCoinStats(poolAddress: string): void {
    statsCache.delete(poolAddress);
}
