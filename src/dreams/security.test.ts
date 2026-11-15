/**
 * Regression tests for the Dreams security audit fixes.
 */
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { Hono } from "hono";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it } from "vitest";
import {
    dreamAuth,
    issueSession,
    sessionMessage,
    verifySessionToken,
    type DreamAuthEnv,
} from "../middleware/dream-session.js";
import { rateLimit, resetRateLimits } from "../middleware/rate-limit.js";
import { measureContribution } from "./contribution.js";
import { cleanText, prepareCoinSchema, swapSchema } from "./validation.js";
import { parseXPostUrl, verifyXPost } from "./x-verify.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function signSession(kp: Keypair, ts = Date.now().toString()) {
    const wallet = kp.publicKey.toBase58();
    const sig = nacl.sign.detached(new TextEncoder().encode(sessionMessage(wallet, ts)), kp.secretKey);
    return { wallet, signature: Buffer.from(sig).toString("base64"), timestamp: ts };
}

describe("session auth (M2)", () => {
    it("issues a token bound to the signing wallet", () => {
        const kp = Keypair.generate();
        const { token } = issueSession(signSession(kp));
        expect(verifySessionToken(token)).toBe(kp.publicKey.toBase58());
    });

    it("rejects legacy dream-ai signatures (domain separation)", () => {
        const kp = Keypair.generate();
        const wallet = kp.publicKey.toBase58();
        const ts = Date.now().toString();
        const legacy = nacl.sign.detached(new TextEncoder().encode(`dream-ai:${wallet}:${ts}`), kp.secretKey);
        expect(() =>
            issueSession({ wallet, signature: Buffer.from(legacy).toString("base64"), timestamp: ts })
        ).toThrow(/Signature/);
    });

    it("rejects stale, far-future and malformed requests without throwing 500s", () => {
        const kp = Keypair.generate();
        expect(() => issueSession(signSession(kp, String(Date.now() - 6 * 60_000)))).toThrow(/Timestamp/);
        expect(() => issueSession(signSession(kp, String(Date.now() + 60_000)))).toThrow(/Timestamp/);
        expect(() =>
            issueSession({ wallet: "abc", signature: "!!", timestamp: Date.now().toString() })
        ).toThrow(/Signature/);
    });

    it("rejects tampered tokens and wrong-wallet signatures", () => {
        const kp = Keypair.generate();
        const { token } = issueSession(signSession(kp));
        const [payload, mac] = token.split(".");
        const forged = Buffer.from(
            JSON.stringify({ w: Keypair.generate().publicKey.toBase58(), exp: Date.now() + 1e6, n: "x" })
        ).toString("base64url");
        expect(verifySessionToken(`${forged}.${mac}`)).toBeNull();
        expect(verifySessionToken(`${payload}.AAAA`)).toBeNull();
        expect(verifySessionToken("garbage")).toBeNull();

        const other = Keypair.generate();
        const s = signSession(other);
        expect(() => issueSession({ ...s, wallet: kp.publicKey.toBase58() })).toThrow(/Signature/);
    });

    it("middleware rejects missing/invalid bearer tokens", async () => {
        const app = new Hono<DreamAuthEnv>().get("/x", dreamAuth, (c) => c.text(c.get("walletAddress")));
        expect((await app.request("/x")).status).toBe(401);
        expect((await app.request("/x", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
        const kp = Keypair.generate();
        const { token } = issueSession(signSession(kp));
        const ok = await app.request("/x", { headers: { Authorization: `Bearer ${token}` } });
        expect(await ok.text()).toBe(kp.publicKey.toBase58());
    });
});

describe("rate limiting (M3)", () => {
    beforeEach(resetRateLimits);

    it("limits per IP and per wallet", async () => {
        const app = new Hono<{ Variables: { walletAddress?: string } }>()
            .use("*", async (c, next) => {
                const w = c.req.header("x-wallet");
                if (w) c.set("walletAddress", w);
                await next();
            })
            .get("/x", rateLimit("t", { windowMs: 60_000, perIp: 3, perWallet: 2 }), (c) => c.text("ok"));
        const call = (ip: string, wallet?: string) =>
            app.request("/x", { headers: { "x-forwarded-for": ip, ...(wallet ? { "x-wallet": wallet } : {}) } });

        // Header = "<client-supplied>, <appended by proxy>"; the proxy's entry wins.
        expect((await call("9.9.9.9, 1.1.1.1", "A")).status).toBe(200);
        expect((await call("1.1.1.1", "A")).status).toBe(200);
        expect((await call("1.1.1.1", "A")).status).toBe(429); // wallet limit
        expect((await call("2.2.2.2")).status).toBe(200);
        expect((await call("2.2.2.2")).status).toBe(200);
        expect((await call("2.2.2.2")).status).toBe(200);
        expect((await call("2.2.2.2")).status).toBe(429); // IP limit
    });

    it("can't be dodged by spoofing the left-most X-Forwarded-For entry", async () => {
        const app = new Hono().get("/x", rateLimit("spoof", { windowMs: 60_000, perIp: 2 }), (c) => c.text("ok"));
        const statuses = [];
        for (let i = 0; i < 3; i++) {
            const res = await app.request("/x", { headers: { "x-forwarded-for": `10.0.0.${i}, 3.3.3.3` } });
            statuses.push(res.status);
        }
        expect(statuses).toEqual([200, 200, 429]);
    });
});

describe("contribution round trips (M1)", () => {
    const supporter = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const otherMint = Keypair.generate().publicKey.toBase58();
    const bal = (i: number, o: string, amount: bigint, mint = USDC) => ({
        accountIndex: i,
        mint,
        owner: o,
        uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: "" },
    });
    const tx = (signers: string[], pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[]) =>
        ({
            slot: 1,
            blockTime: 2_000_000_000,
            meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: pre, postTokenBalances: post },
            transaction: {
                signatures: ["x"],
                message: {
                    accountKeys: signers.map((s) => ({ pubkey: new PublicKey(s), signer: true, writable: true, source: "transaction" })),
                    instructions: [],
                    recentBlockhash: "11111111111111111111111111111111",
                },
            },
        }) as unknown as ParsedTransactionWithMeta;
    const params = { usdcMint: USDC, contributor: supporter, beneficiary: owner, notBeforeUnixSeconds: 1_900_000_000 };

    it("rejects transactions co-signed by the owner", () => {
        const t = tx(
            [supporter, owner],
            [bal(1, supporter, 5_000_000n), bal(2, owner, 0n)],
            [bal(1, supporter, 0n), bal(2, owner, 5_000_000n)]
        );
        expect(() => measureContribution(t, params)).toThrow(/co-signed/);
    });

    it("rejects transactions that send any token back to the supporter", () => {
        const t = tx(
            [supporter],
            [bal(1, supporter, 5_000_000n), bal(2, owner, 0n), bal(3, supporter, 0n, otherMint), bal(4, owner, 9n, otherMint)],
            [bal(1, supporter, 0n), bal(2, owner, 5_000_000n), bal(3, supporter, 9n, otherMint), bal(4, owner, 0n, otherMint)]
        );
        expect(() => measureContribution(t, params)).toThrow(/back to the supporter/);
    });
});

describe("X ownership verification (H3)", () => {
    const fakeFetch = (body: unknown, status = 200) =>
        (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

    it("parses only X/Twitter status URLs", () => {
        expect(parseXPostUrl("https://x.com/alice/status/123?s=20")).toEqual({ handle: "alice", statusId: "123" });
        expect(parseXPostUrl("https://evil.com/alice/status/123")).toBeNull();
        expect(parseXPostUrl("javascript:alert(1)")).toBeNull();
    });

    it("accepts a post by the claimed author that contains the dream id", async () => {
        const v = await verifyXPost(
            "https://twitter.com/Alice/status/42",
            "3xQm9WkPz7Ab",
            fakeFetch({ author_url: "https://x.com/alice", html: "<p>Dream ID 3xQm9WkPz7Ab — please help</p>" })
        );
        expect(v).toEqual({ url: "https://x.com/alice/status/42", handle: "alice" });
    });

    it("rejects someone else's viral post (no dream id)", async () => {
        await expect(
            verifyXPost(
                "https://x.com/victim/status/42",
                "3xQm9WkPz7Ab",
                fakeFetch({ author_url: "https://x.com/victim", html: "<p>Please help with my rent</p>" })
            )
        ).rejects.toThrow(/Dream ID/);
    });

    it("rejects a URL that names a different handle than the real author", async () => {
        await expect(
            verifyXPost(
                "https://x.com/famous/status/42",
                "3xQm9WkPz7Ab",
                fakeFetch({ author_url: "https://x.com/attacker", html: "<p>3xQm9WkPz7Ab</p>" })
            )
        ).rejects.toThrow(/wasn't written/);
    });

    it("reports missing/private posts and X outages distinctly", async () => {
        await expect(verifyXPost("https://x.com/a/status/1", "id12345678", fakeFetch({}, 404))).rejects.toThrow(/isn't public/);
        await expect(verifyXPost("https://x.com/a/status/1", "id12345678", fakeFetch({}, 503))).rejects.toThrow(/Couldn't reach/);
    });
});

describe("input hardening (L7, M5, L3)", () => {
    it("strips extended invisible characters", () => {
        const invisible = [0x2060, 0x061c, 0x2028, 0x00ad, 0x3164, 0x115f].map((c) => String.fromCharCode(c)).join("");
        const tag = String.fromCodePoint(0xe0041);
        expect(cleanText(`a${invisible}b${tag}c`)).toBe("abc");
    });

    it("rejects non-ASCII (homoglyph) coin names", () => {
        expect(prepareCoinSchema.safeParse({ name: "U" + String.fromCharCode(0x0405) + "DC", symbol: "USDC" }).success).toBe(false);
        expect(prepareCoinSchema.safeParse({ name: "Rent Help", symbol: "RENT" }).success).toBe(true);
    });

    it("caps slippage at 15% and defaults to 1%", () => {
        expect(swapSchema.parse({ side: "buy", amountIn: "1" }).slippageBps).toBe(100);
        expect(swapSchema.safeParse({ side: "buy", amountIn: "1", slippageBps: 5000 }).success).toBe(false);
    });

    it("rejects amounts above u64", () => {
        expect(swapSchema.safeParse({ side: "sell", amountIn: "99999999999999999999" }).success).toBe(false);
    });
});
