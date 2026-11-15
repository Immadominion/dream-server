/**
 * API-level end-to-end test of Dreams against a local validator (with DBC
 * cloned — see dbc-localnet-e2e.ts) and a throwaway Postgres.
 *
 * It creates a local "USDC" mint, boots dream-server pointed at it, and drives
 * every /v1/dreams endpoint with wallet-signed requests exactly as the app
 * does, including the abuse cases (replay, impersonation, non-owner actions).
 *
 *   E2E_DATABASE_URL=postgresql://dream@127.0.0.1:55432/dream_e2e \
 *   DREAM_DBC_CONFIG=<localnet config> \
 *     npx tsx scripts/api-localnet-e2e.ts
 */

import {
    createAssociatedTokenAccountIdempotent,
    createMint,
    getAssociatedTokenAddressSync,
    mintTo,
    transfer,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { spawn } from "node:child_process";
import nacl from "tweetnacl";

const RPC = "http://127.0.0.1:8899";
const PORT = 3999;
const API = `http://127.0.0.1:${PORT}`;

const databaseUrl = process.env.E2E_DATABASE_URL;
const dbcConfig = process.env.DREAM_DBC_CONFIG;
if (!databaseUrl || !dbcConfig) {
    console.error("E2E_DATABASE_URL and DREAM_DBC_CONFIG are required");
    process.exit(1);
}

const conn = new Connection(RPC, "confirmed");
let failures = 0;

function check(cond: unknown, label: string, detail?: unknown): void {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        failures++;
        console.log(`  ✗ ${label}`, detail ?? "");
    }
}

async function fund(kp: Keypair, sol: number): Promise<void> {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
}

const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef0123456789";
const sessions = new Map<string, string>();

/** Sign in exactly like the app: one signed message → bearer session. */
async function session(kp: Keypair): Promise<string> {
    const wallet = kp.publicKey.toBase58();
    const cached = sessions.get(wallet);
    if (cached) return cached;
    const timestamp = Date.now().toString();
    const sig = nacl.sign.detached(new TextEncoder().encode(`dream-session:v1:${wallet}:${timestamp}`), kp.secretKey);
    const res = await fetch(`${API}/v1/dreams/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, signature: Buffer.from(sig).toString("base64"), timestamp }),
    });
    const { token } = (await res.json()) as { token: string };
    sessions.set(wallet, token);
    return token;
}

async function call(
    method: string,
    path: string,
    opts: { as?: Keypair; admin?: boolean; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
    const auth: Record<string, string> = opts.admin
        ? { Authorization: `Bearer ${ADMIN_TOKEN}` }
        : opts.as
            ? { Authorization: `Bearer ${await session(opts.as)}` }
            : {};
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...auth, ...(opts.headers ?? {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
        json = JSON.parse(text);
    } catch {
        /* non-JSON body */
    }
    return { status: res.status, json };
}

/** Contributions are verified at `finalized`, which trails confirmation. */
async function contribute(id: string, as: Keypair, txSignature: string) {
    for (let i = 0; i < 20; i++) {
        const r = await call("POST", `/v1/dreams/${id}/contributions`, { as, body: { txSignature } });
        if (r.status !== 503 && r.status !== 404) return r;
        await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error("contribution never became visible");
}

/** Sign a server-built tx as the app does (splice signature) and submit. */
async function signAndSend(base64: string, signer: Keypair): Promise<string> {
    const tx = Transaction.from(Buffer.from(base64, "base64"));
    tx.addSignature(signer.publicKey, Buffer.from(nacl.sign.detached(tx.serializeMessage(), signer.secretKey)));
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
    return sig;
}

async function waitForHealth(): Promise<void> {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`${API}/health`);
            if (res.ok) return;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("server did not become healthy");
}

async function main(): Promise<void> {
    const mintAuthority = Keypair.generate();
    const owner = Keypair.generate();
    const supporter = Keypair.generate();
    const stranger = Keypair.generate();
    await Promise.all([fund(mintAuthority, 5), fund(owner, 5), fund(supporter, 20), fund(stranger, 2)]);

    const usdc = await createMint(conn, mintAuthority, mintAuthority.publicKey, null, 6);
    const supporterAta = await createAssociatedTokenAccountIdempotent(conn, supporter, usdc, supporter.publicKey);
    const ownerAta = await createAssociatedTokenAccountIdempotent(conn, supporter, usdc, owner.publicKey);
    await mintTo(conn, mintAuthority, usdc, supporterAta, mintAuthority, 100_000_000n);
    console.log(`local USDC mint ${usdc.toBase58()}`);

    const server = spawn("npx", ["tsx", "src/index.ts"], {
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: "development",
            LOG_LEVEL: "warn",
            DATABASE_URL: databaseUrl,
            SOLANA_RPC_URL: RPC,
            USDC_MINT: usdc.toBase58(),
            DREAM_DBC_CONFIG: dbcConfig,
            PUBLIC_BASE_URL: API,
            PRIORITY_FEE_MICROLAMPORTS: "0",
            COPY_ENGINE_ENABLED: "false",
            DREAM_STALE_LAUNCH_SECONDS: "2",
            DREAM_REPORT_HIDE_THRESHOLD: "1",
            ADMIN_API_TOKEN: ADMIN_TOKEN,
            TELEGRAM_BOT_TOKEN: "",
            TELEGRAM_CHAT_ID: "",
        },
        stdio: ["ignore", "ignore", "inherit"],
    });

    try {
        await waitForHealth();

        console.log("\nPosting");
        const bad = await call("POST", "/v1/dreams", { as: owner, body: { title: "x", story: "y", category: "rent", goalUsdc: "-1" } });
        check(bad.status === 400, "rejects invalid dream", bad.status);
        const unauth = await call("POST", "/v1/dreams", { body: { title: "Help with rent this month" } });
        check(unauth.status === 401, "rejects unauthenticated create", unauth.status);
        {
            const ts = Date.now().toString();
            const w = owner.publicKey.toBase58();
            const legacySig = nacl.sign.detached(new TextEncoder().encode(`dream-ai:${w}:${ts}`), owner.secretKey);
            const legacy = await call("POST", "/v1/dreams", {
                headers: { "X-Wallet-Address": w, "X-Wallet-Signature": Buffer.from(legacySig).toString("base64"), "X-Timestamp": ts },
                body: { title: "Legacy header attempt", story: "x".repeat(60), category: "rent", goalUsdc: "10" },
            });
            check(legacy.status === 401, "rejects legacy dream-ai signatures", legacy.status);
        }

        const created = await call("POST", "/v1/dreams", {
            as: owner,
            body: {
                title: "Help me pay my final-year school fees",
                story: "I am one semester away from graduating and need help covering the last tuition balance before exams.",
                category: "education",
                goalUsdc: "30",
            },
        });
        check(created.status === 201, "creates dream", created.json);
        const id: string = created.json.dream.id;

        const feed = await call("GET", "/v1/dreams?sort=new");
        check(feed.json.dreams.some((d: { id: string }) => d.id === id), "appears in feed");
        check(feed.json.coinLaunchesEnabled === true, "reports coin launches enabled");

        console.log("\nFunding (wallet-to-wallet USDC, verified on-chain)");
        const payment = await transfer(conn, supporter, supporterAta, getAssociatedTokenAddressSync(usdc, owner.publicKey), supporter, 25_000_000n);
        const impostor = await contribute(id, stranger, payment);
        check(impostor.status === 400, "rejects someone else's transfer", impostor.json);

        const contrib = await contribute(id, supporter, payment);
        check(contrib.status === 200 && contrib.json.credited === "25", "credits verified $25", contrib.json);
        check(contrib.json.dream?.raisedUsdc === "25" && contrib.json.dream?.supporterCount === 1, "updates raised + supporters");

        const replay = await contribute(id, supporter, payment);
        check(replay.json.alreadyRecorded === true && replay.json.dream.raisedUsdc === "25", "replay is idempotent");

        const second = await transfer(conn, supporter, supporterAta, ownerAta, supporter, 10_000_000n);
        const contrib2 = await contribute(id, supporter, second);
        check(
            contrib2.json.dream?.status === "funded" && contrib2.json.dream?.supporterCount === 1,
            "goal reached → funded; same supporter counted once",
            contrib2.json
        );

        const storyEdit = await call("PATCH", `/v1/dreams/${id}`, { as: owner, body: { story: "y".repeat(60) } });
        check(storyEdit.status === 409, "story is locked once funded", storyEdit.status);

        console.log("\nCoin");
        const notOwner = await call("POST", `/v1/dreams/${id}/coin/prepare`, { as: stranger, body: { name: "Fees", symbol: "FEES" } });
        check(notOwner.status === 404, "non-owner cannot launch", notOwner.status);

        const prep = await call("POST", `/v1/dreams/${id}/coin/prepare`, { as: owner, body: { name: "Final Year Fees", symbol: "$fees" } });
        check(prep.status === 200 && prep.json.mint, "prepares launch tx", prep.json);
        const launchSig = await signAndSend(prep.json.transaction, owner);
        const confirm = await call("POST", `/v1/dreams/${id}/coin/confirm`, { as: owner, body: { mint: prep.json.mint, txSignature: launchSig } });
        check(confirm.json.dream?.coin?.symbol === "FEES", "confirms launch on-chain", confirm.json);

        const again = await call("POST", `/v1/dreams/${id}/coin/prepare`, { as: owner, body: { name: "Again", symbol: "AGN" } });
        check(again.status === 409, "one coin per dream", again.status);

        const meta = await call("GET", `/v1/dreams/coins/${prep.json.mint}/metadata.json`);
        check(meta.status === 200 && meta.json.symbol === "FEES", "serves coin metadata", meta.json);

        const buy = await call("POST", `/v1/dreams/${id}/coin/swap`, {
            as: supporter,
            body: { side: "buy", amountIn: String(2 * LAMPORTS_PER_SOL), slippageBps: 500 },
        });
        check(buy.status === 200, "builds buy", buy.json);
        await signAndSend(buy.json.transaction, supporter);

        // Stats are cached for 30s; the swap route invalidates on build, so
        // fetch after the trade lands.
        await new Promise((r) => setTimeout(r, 1000));
        const detail = await call("GET", `/v1/dreams/${id}`);
        const unclaimed = Number(detail.json.coinStats?.ownerUnclaimedSol ?? 0);
        check(unclaimed > 0, `owner accrued ${unclaimed} SOL in fees`, detail.json.coinStats);

        const strangerClaim = await call("POST", `/v1/dreams/${id}/coin/claim`, { as: stranger });
        check(strangerClaim.status === 404, "stranger cannot claim", strangerClaim.status);
        const claim = await call("POST", `/v1/dreams/${id}/coin/claim`, { as: owner });
        check(claim.status === 200, "builds owner claim", claim.json);
        const before = await conn.getBalance(owner.publicKey);
        await signAndSend(claim.json.transaction, owner);
        check((await conn.getBalance(owner.publicKey)) > before, "owner received fees");

        console.log("\nModeration & lifecycle");
        const selfReport = await call("POST", `/v1/dreams/${id}/report`, { as: owner, body: { reason: "spam" } });
        check(selfReport.status === 400, "owner can't report own dream");
        // Threshold is 1 in this run: a free wallet's report must still not hide it.
        const report = await call("POST", `/v1/dreams/${id}/report`, { as: stranger, body: { reason: "fake" } });
        const dup = await call("POST", `/v1/dreams/${id}/report`, { as: stranger, body: { reason: "fake" } });
        check(report.status === 200 && dup.status === 200, "report is accepted and idempotent");
        const afterFree = await call("GET", `/v1/dreams/${id}`);
        check(afterFree.status === 200, "reports from wallets with no support don't hide a dream");

        const credibleReport = await call("POST", `/v1/dreams/${id}/report`, { as: supporter, body: { reason: "fake" } });
        const afterCredible = await call("GET", `/v1/dreams/${id}`);
        check(credibleReport.status === 200 && afterCredible.status === 404, "a supporter's report hides it for review");

        const hiddenBuy = await call("POST", `/v1/dreams/${id}/coin/swap`, {
            as: supporter,
            body: { side: "buy", amountIn: String(LAMPORTS_PER_SOL / 10), slippageBps: 500 },
        });
        check(hiddenBuy.status === 409, "no new buys while under review");
        const supporterCoins = await conn.getParsedTokenAccountsByOwner(supporter.publicKey, { mint: new PublicKey(prep.json.mint) });
        const coinBal = BigInt(supporterCoins.value[0]!.account.data.parsed.info.tokenAmount.amount as string);
        const hiddenSell = await call("POST", `/v1/dreams/${id}/coin/swap`, {
            as: supporter,
            body: { side: "sell", amountIn: String(coinBal / 2n), slippageBps: 500 },
        });
        check(hiddenSell.status === 200, "holders can still sell while under review", hiddenSell.json);

        const notAdmin = await call("POST", `/v1/dreams/${id}/moderation`, { as: owner, body: { hidden: false } });
        check(notAdmin.status === 404, "moderation requires the operator token");
        const unhide = await call("POST", `/v1/dreams/${id}/moderation`, { admin: true, body: { hidden: false } });
        check(unhide.json.dream?.hidden === false && (await call("GET", `/v1/dreams/${id}`)).status === 200, "operator can unhide");

        const mine = await call("GET", "/v1/dreams/mine", { as: owner });
        check(mine.json.dreams?.length >= 1, "owner can list their dreams");

        const strangerClose = await call("PATCH", `/v1/dreams/${id}`, { as: stranger, body: { status: "closed" } });
        check(strangerClose.status === 404, "stranger cannot close");
        const close = await call("PATCH", `/v1/dreams/${id}`, { as: owner, body: { status: "closed" } });
        check(close.json.dream?.status === "closed", "owner closes dream");
        const late = await transfer(conn, supporter, supporterAta, ownerAta, supporter, 1_000_000n);
        const lateContrib = await contribute(id, supporter, late);
        check(lateContrib.status === 409, "closed dream rejects new contributions");

        console.log("\nLaunch recovery");
        const second2 = await call("POST", "/v1/dreams", {
            as: owner,
            body: {
                title: "Rent for my family this month",
                story: "Our landlord needs the full month by Friday and my salary is two weeks late this time around.",
                category: "rent",
                goalUsdc: "200",
            },
        });
        const id2: string = second2.json.dream.id;
        // Abandoned prepare (never signed) + a launch that lands without /confirm.
        await call("POST", `/v1/dreams/${id2}/coin/prepare`, { as: owner, body: { name: "Abandoned", symbol: "ABN" } });
        const landed = await call("POST", `/v1/dreams/${id2}/coin/prepare`, { as: owner, body: { name: "Rent Help", symbol: "RENT" } });
        await signAndSend(landed.json.transaction, owner);
        await new Promise((r) => setTimeout(r, 3000));
        const recovered = await call("GET", `/v1/dreams/${id2}`);
        check(recovered.json.dream?.coin?.mint === landed.json.mint, "unconfirmed launch is recovered from chain", recovered.json.dream?.coin);
        const recoveredMeta = await call("GET", `/v1/dreams/coins/${landed.json.mint}/metadata.json`);
        check(recoveredMeta.status === 200, "recovered coin metadata still resolves");

        const copy = await call("GET", "/v1/copy/points", { as: owner });
        check(copy.status === 404, "copy-trading routes are disabled", copy.status);
    } finally {
        server.kill("SIGTERM");
    }

    console.log(failures === 0 ? "\nALL API CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
    console.error("✗", err);
    process.exit(1);
});
