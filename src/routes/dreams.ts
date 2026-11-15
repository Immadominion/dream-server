/**
 * Dreams (V2) — people post real needs; supporters fund them directly in USDC
 * or trade the dream's coin, whose creator fees accrue to the person in need.
 *
 * Public:
 *   GET   /v1/dreams                            feed (sort, category, owner, paging)
 *   GET   /v1/dreams/:id                        detail + recent supporters + coin stats
 *   GET   /v1/dreams/coins/:mint/metadata.json  Metaplex metadata for a dream coin
 *   POST  /v1/dreams/session                    exchange a wallet signature for a session
 *
 * Session-authenticated (Authorization: Bearer <session>):
 *   GET   /v1/dreams/mine                       caller's dreams, including hidden ones
 *   POST  /v1/dreams                            create (owner = caller)
 *   PATCH /v1/dreams/:id                        owner edits story (until funded) / closes
 *   POST  /v1/dreams/:id/x                      link the owner's X post (verified)
 *   POST  /v1/dreams/:id/contributions          record a verified USDC transfer
 *   POST  /v1/dreams/:id/report                 flag for moderation
 *   POST  /v1/dreams/:id/coin/prepare           build the owner's launch tx
 *   POST  /v1/dreams/:id/coin/confirm           verify the launch on-chain
 *   POST  /v1/dreams/:id/coin/swap              build a buy/sell tx (any wallet)
 *   POST  /v1/dreams/:id/coin/claim             build the owner's fee-claim tx
 *
 * Operator (Authorization: Bearer <ADMIN_API_TOKEN>):
 *   POST  /v1/dreams/:id/moderation             hide / unhide
 */

import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { z } from "zod";
import config from "../config.js";
import db from "../db/index.js";
import {
    dreamCoinLaunches,
    dreamContributions,
    dreamReports,
    dreams,
    type DreamCoinLaunchRow,
    type DreamRow,
} from "../db/schema.js";
import {
    CoinError,
    buildClaimTx,
    buildLaunchTx,
    buildSwapTx,
    coinLaunchesEnabled,
    connection,
    getCoinStats,
    verifyLaunchedPool,
} from "../dreams/coin.js";
import { ContributionError, measureContribution } from "../dreams/contribution.js";
import { formatLamports, formatUsdc } from "../dreams/money.js";
import {
    confirmCoinSchema,
    contributionSchema,
    createDreamSchema,
    isValidPublicKey,
    linkXSchema,
    listDreamsQuery,
    moderationSchema,
    prepareCoinSchema,
    reportSchema,
    swapSchema,
    updateDreamSchema,
} from "../dreams/validation.js";
import { XVerifyError, verifyXPost } from "../dreams/x-verify.js";
import { logger } from "../logger.js";
import {
    SessionError,
    dreamAuth,
    isAdmin,
    issueSession,
    type DreamAuthEnv,
} from "../middleware/dream-session.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sendTelegram } from "./analytics.js";

const log = logger.child({ module: "dreams" });

const MAX_PENDING_LAUNCHES_PER_DREAM = 5;
const RECENT_SUPPORTERS = 20;
/**
 * A report counts toward auto-hiding only if the reporter funded *this* dream
 * with at least this much. Credibility from any other dream is sybil-able
 * (an attacker funds their own second dream and gets the money back); here,
 * hiding a dream costs the attacker money that goes to the victim.
 */
const CREDIBLE_REPORTER_MIN_MICRO = 1_000_000n; // $1

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** 12-char base58 id: short enough to share in links, 70 bits of entropy. */
function newDreamId(): string {
    return bs58.encode(randomBytes(9));
}

function escapeTelegram(text: string): string {
    return text.replace(/[_*`[\]]/g, "\\$&");
}

function shortWallet(w: string): string {
    return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

// Throttle operator notifications so a spam wave can't bury moderation alerts.
const TELEGRAM_PER_MINUTE = 20;
let telegramWindowStart = 0;
let telegramSent = 0;
function notify(text: string, { priority = false } = {}): void {
    const now = Date.now();
    if (now - telegramWindowStart > MINUTE) {
        telegramWindowStart = now;
        telegramSent = 0;
    }
    if (!priority && telegramSent >= TELEGRAM_PER_MINUTE) return;
    telegramSent++;
    void sendTelegram(text);
}

function toDto(row: DreamRow) {
    return {
        id: row.id,
        ownerWallet: row.ownerWallet,
        title: row.title,
        story: row.story,
        category: row.category,
        goalUsdc: formatUsdc(row.goalUsdcMicro),
        raisedUsdc: formatUsdc(row.raisedUsdcMicro),
        supporterCount: row.supporterCount,
        status: row.status,
        xPostUrl: row.xPostUrl,
        xHandle: row.xHandle,
        hidden: row.hidden,
        coin: row.coinMint
            ? {
                mint: row.coinMint,
                pool: row.coinPool,
                symbol: row.coinSymbol,
                launchedAt: row.coinLaunchedAt?.toISOString() ?? null,
            }
            : null,
        createdAt: row.createdAt.toISOString(),
    };
}

/** Map domain errors to HTTP responses; anything else bubbles to the 500 handler. */
function domainError(c: Context, err: unknown): Response {
    if (err instanceof CoinError || err instanceof ContributionError) {
        return c.json({ error: err.message }, err.statusCode);
    }
    if (err instanceof XVerifyError) return c.json({ error: err.message }, 422);
    throw err;
}

async function findDream(id: string): Promise<DreamRow | null> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{8,16}$/.test(id)) return null;
    const rows = await db.select().from(dreams).where(eq(dreams.id, id)).limit(1);
    return rows[0] ?? null;
}

/**
 * Attach a verified launch to its dream. Only a *pending* launch can be
 * attached; if the dream already has a different coin, this launch landed
 * second and is marked orphaned (its metadata then says it is unofficial).
 */
async function attachCoin(
    dream: DreamRow,
    launch: DreamCoinLaunchRow,
    txSignature: string | null
): Promise<DreamRow | null> {
    return db.transaction(async (trx) => {
        const [updated] = await trx
            .update(dreams)
            .set({
                coinMint: launch.mint,
                coinPool: launch.pool,
                coinSymbol: launch.symbol,
                coinLaunchedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(and(eq(dreams.id, dream.id), sql`${dreams.coinMint} is null`))
            .returning();

        if (updated) {
            await trx
                .update(dreamCoinLaunches)
                .set({ status: "confirmed", txSignature })
                .where(eq(dreamCoinLaunches.mint, launch.mint));
            return updated;
        }

        // Someone else attached first. Orphan this launch only if it isn't
        // the one that won (concurrent confirm/reconcile of the same mint).
        const [current] = await trx.select().from(dreams).where(eq(dreams.id, dream.id));
        if (current && current.coinMint !== launch.mint) {
            await trx
                .update(dreamCoinLaunches)
                .set({ status: "orphaned" })
                .where(and(eq(dreamCoinLaunches.mint, launch.mint), eq(dreamCoinLaunches.status, "pending")));
            return null;
        }
        return current ?? null;
    });
}

/**
 * Settle stale pending launches against the chain:
 *  - landed and valid (e.g. the app died before /confirm) → attach it;
 *  - landed but not a valid Dream pool → mark invalid (never re-checked);
 *  - not found AND its blockhash has expired → it can never land → delete.
 * A "not found" before expiry is left alone (RPC lag must not lose a coin).
 */
async function reconcileLaunches(dream: DreamRow): Promise<DreamRow> {
    const stale = await db
        .select()
        .from(dreamCoinLaunches)
        .where(
            and(
                eq(dreamCoinLaunches.dreamId, dream.id),
                eq(dreamCoinLaunches.status, "pending"),
                lt(dreamCoinLaunches.createdAt, new Date(Date.now() - config.DREAM_STALE_LAUNCH_SECONDS * 1000))
            )
        );
    if (stale.length === 0) return dream;

    let blockHeight: number | null = null;
    let current = dream;
    for (const launch of stale) {
        try {
            await verifyLaunchedPool({ pool: launch.pool, mint: launch.mint, owner: dream.ownerWallet });
        } catch (err) {
            if (err instanceof CoinError && err.statusCode === 409) {
                blockHeight ??= await connection().getBlockHeight("finalized");
                if (launch.lastValidBlockHeight != null && blockHeight > launch.lastValidBlockHeight) {
                    await db.delete(dreamCoinLaunches).where(eq(dreamCoinLaunches.mint, launch.mint));
                }
            } else if (err instanceof CoinError) {
                await db
                    .update(dreamCoinLaunches)
                    .set({ status: "invalid" })
                    .where(eq(dreamCoinLaunches.mint, launch.mint));
            } else {
                log.warn({ err, mint: launch.mint }, "could not reconcile launch");
            }
            continue;
        }
        const attached = await attachCoin(current, launch, null);
        if (attached) current = attached;
    }
    return current;
}

async function isCredibleReporter(wallet: string, dreamId: string): Promise<boolean> {
    const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${dreamContributions.amountUsdcMicro}), 0)::text` })
        .from(dreamContributions)
        .where(and(eq(dreamContributions.contributorWallet, wallet), eq(dreamContributions.dreamId, dreamId)));
    return BigInt(row?.total ?? "0") >= CREDIBLE_REPORTER_MIN_MICRO;
}

// ── Router ───────────────────────────────────────────────────────────────────

const app = new Hono<DreamAuthEnv>();

// POST /v1/dreams/session — the only place a raw wallet signature is accepted.
const sessionSchema = z.object({
    wallet: z.string().refine(isValidPublicKey, "Invalid wallet"),
    signature: z.string().max(200),
    timestamp: z.string().max(20),
});
app.post(
    "/session",
    rateLimit("dreams:session", { windowMs: 10 * MINUTE, perIp: 30 }),
    zValidator("json", sessionSchema),
    (c) => {
        try {
            return c.json(issueSession(c.req.valid("json")));
        } catch (err) {
            if (err instanceof SessionError) return c.json({ error: err.message }, 401);
            throw err;
        }
    }
);

// GET /v1/dreams — public feed. Hidden dreams never appear here.
app.get("/", rateLimit("dreams:read", { windowMs: MINUTE, perIp: 120 }), zValidator("query", listDreamsQuery), async (c) => {
    const q = c.req.valid("query");

    const filters: SQL[] = [eq(dreams.hidden, false)];
    if (q.category) filters.push(eq(dreams.category, q.category));
    if (q.owner) filters.push(eq(dreams.ownerWallet, q.owner));
    else filters.push(sql`${dreams.status} <> 'closed'`);

    const order =
        q.sort === "closest"
            ? [
                desc(sql`(${dreams.raisedUsdcMicro})::numeric / nullif(${dreams.goalUsdcMicro}, 0)`),
                desc(dreams.createdAt),
            ]
            : q.sort === "supported"
                ? [desc(dreams.supporterCount), desc(dreams.createdAt)]
                : [desc(dreams.createdAt)];

    const rows = await db
        .select()
        .from(dreams)
        .where(and(...filters))
        .orderBy(...order)
        .limit(q.limit + 1)
        .offset(q.cursor);

    const hasMore = rows.length > q.limit;
    return c.json({
        dreams: rows.slice(0, q.limit).map(toDto),
        nextCursor: hasMore ? q.cursor + q.limit : null,
        coinLaunchesEnabled: coinLaunchesEnabled(),
    });
});

// GET /v1/dreams/mine — the owner's own dreams, including hidden ones.
app.get("/mine", dreamAuth, async (c) => {
    const rows = await db
        .select()
        .from(dreams)
        .where(eq(dreams.ownerWallet, c.get("walletAddress")))
        .orderBy(desc(dreams.createdAt))
        .limit(50);
    return c.json({ dreams: rows.map(toDto), coinLaunchesEnabled: coinLaunchesEnabled() });
});

// GET /v1/dreams/coins/:mint/metadata.json — referenced on-chain by the coin.
app.get("/coins/:mint/metadata.json", rateLimit("dreams:meta", { windowMs: MINUTE, perIp: 240 }), async (c) => {
    const mint = c.req.param("mint");
    if (!isValidPublicKey(mint)) return c.json({ error: "Not found" }, 404);

    const rows = await db
        .select({ launch: dreamCoinLaunches, dream: dreams })
        .from(dreamCoinLaunches)
        .innerJoin(dreams, eq(dreams.id, dreamCoinLaunches.dreamId))
        .where(eq(dreamCoinLaunches.mint, mint))
        .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    const dreamUrl = `https://trydream.fun/d/${row.dream.id}`;
    // Official = the dream's attached coin, or a pending launch while the
    // dream has no coin yet. Anything else (orphaned/invalid, or pending after
    // a different mint won) is labelled unofficial.
    const official =
        row.dream.coinMint === mint ||
        (row.launch.status === "pending" && row.dream.coinMint === null);
    // Metadata is fetched live by wallets/explorers, so it can reflect the
    // dream's current state even though the URI itself is immutable.
    const description = !official
        ? "Unofficial coin — this is NOT the official coin of any Dream. Fees do not support a verified dream."
        : row.dream.hidden
            ? "This dream is under review."
            : `${row.dream.title} — creator fees from this coin go to the person behind this dream. ${dreamUrl}`;

    c.header("Cache-Control", "public, max-age=300");
    return c.json({
        name: row.launch.name,
        symbol: row.launch.symbol,
        description,
        image: config.DREAM_COIN_IMAGE_URL,
        ...(official && !row.dream.hidden
            ? {
                external_url: dreamUrl,
                extensions: { website: dreamUrl, ...(row.dream.xPostUrl ? { twitter: row.dream.xPostUrl } : {}) },
            }
            : {}),
    });
});

// GET /v1/dreams/:id — detail. Hidden dreams 404 for the public.
app.get("/:id", rateLimit("dreams:read", { windowMs: MINUTE, perIp: 120 }), async (c) => {
    const found = await findDream(c.req.param("id"));
    if (!found || found.hidden) return c.json({ error: "Dream not found" }, 404);
    const dream = found.coinMint ? found : await reconcileLaunches(found);

    const supporters = await db
        .select({
            wallet: dreamContributions.contributorWallet,
            amountUsdcMicro: dreamContributions.amountUsdcMicro,
            txSignature: dreamContributions.txSignature,
            createdAt: dreamContributions.createdAt,
        })
        .from(dreamContributions)
        .where(eq(dreamContributions.dreamId, dream.id))
        .orderBy(desc(dreamContributions.createdAt))
        .limit(RECENT_SUPPORTERS);

    let coinStats: Record<string, unknown> | null = null;
    if (dream.coinPool) {
        try {
            const s = await getCoinStats(dream.coinPool);
            coinStats = {
                graduated: s.graduated,
                curveProgress: s.curveProgress,
                ownerUnclaimedSol: formatLamports(s.ownerUnclaimedLamports),
                ownerLifetimeSol: formatLamports(s.ownerLifetimeLamports),
            };
        } catch (err) {
            // Coin stats are best-effort: an RPC hiccup must not break the page.
            log.warn({ err, pool: dream.coinPool }, "coin stats unavailable");
        }
    }

    return c.json({
        dream: toDto(dream),
        coinStats,
        supporters: supporters.map((s) => ({
            wallet: s.wallet,
            amountUsdc: formatUsdc(s.amountUsdcMicro),
            txSignature: s.txSignature,
            createdAt: s.createdAt.toISOString(),
        })),
    });
});

// POST /v1/dreams — create. The caller's wallet is the only beneficiary.
app.post(
    "/",
    dreamAuth,
    rateLimit("dreams:create", { windowMs: HOUR, perIp: 10, perWallet: 3 }),
    zValidator("json", createDreamSchema),
    async (c) => {
        const owner = c.get("walletAddress");
        const body = c.req.valid("json");

        const [{ open } = { open: 0 }] = await db
            .select({ open: sql<number>`count(*)::int` })
            .from(dreams)
            .where(and(eq(dreams.ownerWallet, owner), sql`${dreams.status} <> 'closed'`));
        if (open >= config.DREAM_MAX_OPEN_PER_WALLET) {
            return c.json(
                { error: `You can have at most ${config.DREAM_MAX_OPEN_PER_WALLET} active dreams. Close one first.` },
                409
            );
        }

        const [row] = await db
            .insert(dreams)
            .values({
                id: newDreamId(),
                ownerWallet: owner,
                title: body.title,
                story: body.story,
                category: body.category,
                goalUsdcMicro: body.goalUsdc,
            })
            .returning();

        notify(
            `🌙 *New dream* — ${escapeTelegram(row!.title)}\nGoal: $${formatUsdc(row!.goalUsdcMicro)} · ${row!.category} · ${shortWallet(owner)}`
        );
        return c.json({ dream: toDto(row!) }, 201);
    }
);

// PATCH /v1/dreams/:id — owner edits. Title/goal never change; the story is
// frozen once anyone has funded the dream, so supporters always funded what
// they read.
app.patch(
    "/:id",
    dreamAuth,
    rateLimit("dreams:edit", { windowMs: HOUR, perIp: 30, perWallet: 20 }),
    zValidator("json", updateDreamSchema),
    async (c) => {
        const owner = c.get("walletAddress");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.ownerWallet !== owner) return c.json({ error: "Dream not found" }, 404);

        const body = c.req.valid("json");
        if (body.story !== undefined && dream.raisedUsdcMicro > 0n) {
            return c.json({ error: "The story can't change after people have funded it" }, 409);
        }
        const [row] = await db
            .update(dreams)
            .set({
                ...(body.story !== undefined ? { story: body.story } : {}),
                ...(body.status ? { status: body.status } : {}),
                updatedAt: new Date(),
            })
            .where(eq(dreams.id, dream.id))
            .returning();
        return c.json({ dream: toDto(row!) });
    }
);

// POST /v1/dreams/:id/x — link the owner's X post after proving they wrote it.
app.post(
    "/:id/x",
    dreamAuth,
    rateLimit("dreams:x", { windowMs: HOUR, perIp: 20, perWallet: 10 }),
    zValidator("json", linkXSchema),
    async (c) => {
        const owner = c.get("walletAddress");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.ownerWallet !== owner) return c.json({ error: "Dream not found" }, 404);
        if (dream.xPostUrl && dream.raisedUsdcMicro > 0n) {
            return c.json({ error: "Your X post can't change after people have funded this dream" }, 409);
        }

        try {
            const verified = await verifyXPost(c.req.valid("json").url, dream.id);
            const [row] = await db
                .update(dreams)
                .set({ xPostUrl: verified.url, xHandle: verified.handle, updatedAt: new Date() })
                .where(eq(dreams.id, dream.id))
                .returning();
            return c.json({ dream: toDto(row!) });
        } catch (err) {
            return domainError(c, err);
        }
    }
);

// POST /v1/dreams/:id/contributions — record a wallet-to-wallet USDC transfer.
app.post(
    "/:id/contributions",
    dreamAuth,
    rateLimit("dreams:contribute", { windowMs: MINUTE, perIp: 30, perWallet: 20 }),
    zValidator("json", contributionSchema),
    async (c) => {
        const contributor = c.get("walletAddress");
        const { txSignature } = c.req.valid("json");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.hidden) return c.json({ error: "Dream not found" }, 404);
        if (dream.status === "closed") return c.json({ error: "This dream is closed" }, 409);

        const existing = await db
            .select({ dreamId: dreamContributions.dreamId })
            .from(dreamContributions)
            .where(eq(dreamContributions.txSignature, txSignature))
            .limit(1);
        if (existing[0]) {
            if (existing[0].dreamId !== dream.id) return c.json({ error: "Transaction already used" }, 409);
            return c.json({ ok: true, alreadyRecorded: true, dream: toDto(dream) });
        }

        let amount: bigint;
        try {
            // Finalized: a credited transfer can never be rolled back.
            const tx = await connection().getParsedTransaction(txSignature, {
                commitment: "finalized",
                maxSupportedTransactionVersion: 0,
            });
            amount = measureContribution(tx, {
                usdcMint: config.USDC_MINT,
                contributor,
                beneficiary: dream.ownerWallet,
                notBeforeUnixSeconds: Math.floor(dream.createdAt.getTime() / 1000),
            });
        } catch (err) {
            if (err instanceof ContributionError) return domainError(c, err);
            log.warn({ err, txSignature }, "contribution lookup failed");
            return c.json({ error: "Couldn't read that transaction yet — try again shortly" }, 503);
        }

        const updated = await db.transaction(async (trx) => {
            // Lock the dream row so concurrent contributions serialize cleanly.
            await trx.execute(sql`select 1 from ${dreams} where ${dreams.id} = ${dream.id} for update`);

            const inserted = await trx
                .insert(dreamContributions)
                .values({ txSignature, dreamId: dream.id, contributorWallet: contributor, amountUsdcMicro: amount })
                .onConflictDoNothing()
                .returning({ tx: dreamContributions.txSignature });
            if (inserted.length === 0) return null; // raced with an identical request

            const [{ prior } = { prior: 0 }] = await trx
                .select({ prior: sql<number>`count(*)::int` })
                .from(dreamContributions)
                .where(
                    and(
                        eq(dreamContributions.dreamId, dream.id),
                        eq(dreamContributions.contributorWallet, contributor)
                    )
                );

            const [row] = await trx
                .update(dreams)
                .set({
                    raisedUsdcMicro: sql`${dreams.raisedUsdcMicro} + ${amount}`,
                    supporterCount: prior === 1 ? sql`${dreams.supporterCount} + 1` : dreams.supporterCount,
                    status: sql`case when ${dreams.status} = 'open' and ${dreams.raisedUsdcMicro} + ${amount} >= ${dreams.goalUsdcMicro} then 'funded' else ${dreams.status} end`,
                    updatedAt: new Date(),
                })
                .where(eq(dreams.id, dream.id))
                .returning();
            return row!;
        });

        if (!updated) {
            const [fresh] = await db.select().from(dreams).where(eq(dreams.id, dream.id));
            return c.json({ ok: true, alreadyRecorded: true, dream: toDto(fresh!) });
        }

        notify(
            `💸 *$${formatUsdc(amount)}* to "${escapeTelegram(updated.title)}" from ${shortWallet(contributor)} — $${formatUsdc(updated.raisedUsdcMicro)}/$${formatUsdc(updated.goalUsdcMicro)}`
        );
        return c.json({ ok: true, credited: formatUsdc(amount), dream: toDto(updated) });
    }
);

// POST /v1/dreams/:id/report — anyone can report (the operator is alerted);
// only reporters who funded this dream count toward auto-hiding it.
app.post(
    "/:id/report",
    dreamAuth,
    rateLimit("dreams:report", { windowMs: HOUR, perIp: 30, perWallet: 20 }),
    zValidator("json", reportSchema),
    async (c) => {
        const reporter = c.get("walletAddress");
        const { reason } = c.req.valid("json");
        const dream = await findDream(c.req.param("id"));
        if (!dream) return c.json({ error: "Dream not found" }, 404);
        if (dream.ownerWallet === reporter) return c.json({ error: "You can't report your own dream" }, 400);

        const credible = await isCredibleReporter(reporter, dream.id);
        const result = await db.transaction(async (trx) => {
            const inserted = await trx
                .insert(dreamReports)
                .values({ dreamId: dream.id, reporterWallet: reporter, reason, credible })
                .onConflictDoNothing()
                .returning({ id: dreamReports.dreamId });
            if (inserted.length === 0) return { newlyHidden: false, first: false };

            const [{ credibleReports } = { credibleReports: 0 }] = await trx
                .select({ credibleReports: sql<number>`count(*)::int` })
                .from(dreamReports)
                .where(and(eq(dreamReports.dreamId, dream.id), eq(dreamReports.credible, true)));

            const hide = credibleReports >= config.DREAM_REPORT_HIDE_THRESHOLD;
            const [row] = await trx
                .update(dreams)
                .set({
                    reportCount: sql`${dreams.reportCount} + 1`,
                    ...(hide ? { hidden: true } : {}),
                })
                .where(eq(dreams.id, dream.id))
                .returning({ hidden: dreams.hidden, reportCount: dreams.reportCount });
            return { newlyHidden: row?.hidden === true && !dream.hidden, first: row?.reportCount === 1 };
        });

        if (result.newlyHidden) {
            notify(`🚩 Dream hidden after credible reports: "${escapeTelegram(dream.title)}" (${dream.id}) — review it`, {
                priority: true,
            });
        } else if (result.first) {
            notify(`⚠️ First report on "${escapeTelegram(dream.title)}" (${dream.id}): ${reason}`, { priority: true });
        }
        return c.json({ ok: true });
    }
);

// POST /v1/dreams/:id/moderation — operator hide/unhide.
app.post("/:id/moderation", zValidator("json", moderationSchema), async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Not found" }, 404);
    const dream = await findDream(c.req.param("id"));
    if (!dream) return c.json({ error: "Dream not found" }, 404);
    const { hidden } = c.req.valid("json");
    const [row] = await db
        .update(dreams)
        .set({ hidden, updatedAt: new Date() })
        .where(eq(dreams.id, dream.id))
        .returning();
    log.info({ dreamId: dream.id, hidden }, "moderation decision");
    return c.json({ dream: toDto(row!) });
});

// ── Coin ─────────────────────────────────────────────────────────────────────

app.post(
    "/:id/coin/prepare",
    dreamAuth,
    rateLimit("dreams:coin-prepare", { windowMs: HOUR, perIp: 20, perWallet: 10 }),
    zValidator("json", prepareCoinSchema),
    async (c) => {
        const owner = c.get("walletAddress");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.ownerWallet !== owner) return c.json({ error: "Dream not found" }, 404);
        if (dream.hidden || dream.status === "closed") return c.json({ error: "This dream can't launch a coin" }, 409);
        const settled = dream.coinMint ? dream : await reconcileLaunches(dream);
        if (settled.coinMint) return c.json({ error: "This dream already has a coin", dream: toDto(settled) }, 409);

        const [{ pending } = { pending: 0 }] = await db
            .select({ pending: sql<number>`count(*)::int` })
            .from(dreamCoinLaunches)
            .where(and(eq(dreamCoinLaunches.dreamId, dream.id), eq(dreamCoinLaunches.status, "pending")));
        if (pending >= MAX_PENDING_LAUNCHES_PER_DREAM) {
            return c.json({ error: "Too many unfinished launches — wait a few minutes and retry" }, 429);
        }

        const { name, symbol } = c.req.valid("json");
        try {
            const built = await buildLaunchTx({ owner, name, symbol });
            await db.insert(dreamCoinLaunches).values({
                mint: built.mint,
                dreamId: dream.id,
                pool: built.pool,
                name,
                symbol,
                lastValidBlockHeight: built.lastValidBlockHeight,
            });
            return c.json(built);
        } catch (err) {
            return domainError(c, err);
        }
    }
);

app.post(
    "/:id/coin/confirm",
    dreamAuth,
    rateLimit("dreams:coin-confirm", { windowMs: MINUTE, perIp: 30, perWallet: 20 }),
    zValidator("json", confirmCoinSchema),
    async (c) => {
        const owner = c.get("walletAddress");
        const { mint, txSignature } = c.req.valid("json");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.ownerWallet !== owner) return c.json({ error: "Dream not found" }, 404);
        if (dream.coinMint === mint) return c.json({ dream: toDto(dream) });
        if (dream.coinMint) return c.json({ error: "This dream already has a coin" }, 409);

        const [launch] = await db
            .select()
            .from(dreamCoinLaunches)
            .where(
                and(
                    eq(dreamCoinLaunches.mint, mint),
                    eq(dreamCoinLaunches.dreamId, dream.id),
                    eq(dreamCoinLaunches.status, "pending")
                )
            )
            .limit(1);
        if (!launch) return c.json({ error: "Unknown launch" }, 404);

        try {
            await verifyLaunchedPool({ pool: launch.pool, mint, owner });
        } catch (err) {
            return domainError(c, err);
        }

        // txSignature is client-supplied and stored for reference only; the
        // on-chain pool check above is what makes the launch real.
        const row = await attachCoin(dream, launch, txSignature);
        if (!row || row.coinMint !== mint) return c.json({ error: "This dream already has a coin" }, 409);

        notify(`🪙 *$${escapeTelegram(launch.symbol)}* launched for "${escapeTelegram(dream.title)}"`);
        return c.json({ dream: toDto(row) });
    }
);

app.post(
    "/:id/coin/swap",
    dreamAuth,
    rateLimit("dreams:coin-swap", { windowMs: MINUTE, perIp: 60, perWallet: 30 }),
    zValidator("json", swapSchema),
    async (c) => {
        const wallet = c.get("walletAddress");
        const body = c.req.valid("json");
        const dream = await findDream(c.req.param("id"));
        if (!dream || !dream.coinPool) return c.json({ error: "Coin not found" }, 404);
        // Holders must always be able to exit, even if the dream is hidden.
        if (dream.hidden && body.side === "buy") return c.json({ error: "This dream is under review" }, 409);

        try {
            return c.json(await buildSwapTx({ pool: dream.coinPool, owner: wallet, ...body }));
        } catch (err) {
            return domainError(c, err);
        }
    }
);

app.post(
    "/:id/coin/claim",
    dreamAuth,
    rateLimit("dreams:coin-claim", { windowMs: MINUTE, perIp: 20, perWallet: 10 }),
    async (c) => {
        const owner = c.get("walletAddress");
        const dream = await findDream(c.req.param("id"));
        if (!dream || dream.ownerWallet !== owner || !dream.coinPool) return c.json({ error: "Coin not found" }, 404);

        try {
            return c.json(await buildClaimTx({ pool: dream.coinPool, owner }));
        } catch (err) {
            return domainError(c, err);
        }
    }
);

export default app;
