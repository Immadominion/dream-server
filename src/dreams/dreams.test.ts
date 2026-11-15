import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ContributionError, measureContribution } from "./contribution.js";
import { CREATOR_FEE_PERCENT, buildDreamCurve } from "./curve.js";
import { formatLamports, formatUsdc, parseUsdc } from "./money.js";
import { cleanText, createDreamSchema, prepareCoinSchema, swapSchema } from "./validation.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const supporter = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate().publicKey.toBase58();
const stranger = Keypair.generate().publicKey.toBase58();

function balance(accountIndex: number, ownerWallet: string, amount: bigint, mint = USDC) {
    return {
        accountIndex,
        mint,
        owner: ownerWallet,
        uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: "" },
    };
}

function fakeTx(opts: {
    signer?: string;
    err?: unknown;
    blockTime?: number | null;
    pre: ReturnType<typeof balance>[];
    post: ReturnType<typeof balance>[];
}): ParsedTransactionWithMeta {
    const signer = opts.signer ?? supporter;
    return {
        slot: 1,
        blockTime: opts.blockTime === undefined ? 2_000_000_000 : opts.blockTime,
        meta: {
            err: opts.err ?? null,
            fee: 5000,
            preBalances: [],
            postBalances: [],
            preTokenBalances: opts.pre,
            postTokenBalances: opts.post,
        },
        transaction: {
            signatures: ["x"],
            message: {
                accountKeys: [
                    { pubkey: new PublicKey(signer), signer: true, writable: true, source: "transaction" },
                    { pubkey: new PublicKey(owner), signer: false, writable: true, source: "transaction" },
                ],
                instructions: [],
                recentBlockhash: "11111111111111111111111111111111",
            },
        },
    } as unknown as ParsedTransactionWithMeta;
}

const params = { usdcMint: USDC, contributor: supporter, beneficiary: owner, notBeforeUnixSeconds: 1_900_000_000 };

describe("money", () => {
    it("parses and formats USDC exactly", () => {
        expect(parseUsdc("25")).toBe(25_000_000n);
        expect(parseUsdc("0.000001")).toBe(1n);
        expect(parseUsdc("12.5")).toBe(12_500_000n);
        expect(formatUsdc(12_500_000n)).toBe("12.5");
        expect(formatUsdc(1n)).toBe("0.000001");
        expect(formatLamports(1_500_000_000n)).toBe("1.5");
    });

    it("rejects malformed amounts", () => {
        for (const bad of ["", "-1", "1.0000001", "1e3", "abc", "1,000", " . "]) {
            expect(parseUsdc(bad)).toBeNull();
        }
    });
});

describe("measureContribution", () => {
    it("credits the amount that moved from supporter to owner", () => {
        const tx = fakeTx({
            pre: [balance(2, supporter, 50_000_000n), balance(3, owner, 1_000_000n)],
            post: [balance(2, supporter, 40_000_000n), balance(3, owner, 11_000_000n)],
        });
        expect(measureContribution(tx, params)).toBe(10_000_000n);
    });

    it("handles a freshly created owner token account (no pre balance)", () => {
        const tx = fakeTx({
            pre: [balance(2, supporter, 5_000_000n)],
            post: [balance(2, supporter, 0n), balance(3, owner, 5_000_000n)],
        });
        expect(measureContribution(tx, params)).toBe(5_000_000n);
    });

    it("credits only the overlap when a third party also paid the owner", () => {
        const tx = fakeTx({
            pre: [balance(2, supporter, 5_000_000n), balance(3, owner, 0n), balance(4, stranger, 9_000_000n)],
            post: [balance(2, supporter, 4_000_000n), balance(3, owner, 10_000_000n), balance(4, stranger, 0n)],
        });
        expect(measureContribution(tx, params)).toBe(1_000_000n);
    });

    it("ignores other mints", () => {
        const fake = Keypair.generate().publicKey.toBase58();
        const tx = fakeTx({
            pre: [balance(2, supporter, 5_000_000n, fake), balance(3, owner, 0n, fake)],
            post: [balance(2, supporter, 0n, fake), balance(3, owner, 5_000_000n, fake)],
        });
        expect(() => measureContribution(tx, params)).toThrow(ContributionError);
    });

    it("rejects failed, unsigned, stale, missing and self transfers", () => {
        const ok = {
            pre: [balance(2, supporter, 5_000_000n), balance(3, owner, 0n)],
            post: [balance(2, supporter, 0n), balance(3, owner, 5_000_000n)],
        };
        expect(() => measureContribution(null, params)).toThrow(/not found/);
        expect(() => measureContribution(fakeTx({ ...ok, err: { InstructionError: [0, "x"] } }), params)).toThrow(/failed/);
        expect(() => measureContribution(fakeTx({ ...ok, signer: stranger }), params)).toThrow(/not signed/);
        expect(() => measureContribution(fakeTx({ ...ok, blockTime: 1_000 }), params)).toThrow(/predates/);
        expect(() => measureContribution(fakeTx(ok), { ...params, contributor: owner })).toThrow(/own dream/);
    });

    it("rejects dust", () => {
        const tx = fakeTx({
            pre: [balance(2, supporter, 5_000n), balance(3, owner, 0n)],
            post: [balance(2, supporter, 0n), balance(3, owner, 5_000n)],
        });
        expect(() => measureContribution(tx, params)).toThrow(ContributionError);
    });
});

describe("validation", () => {
    it("strips bidi/zero-width/control characters", () => {
        expect(cleanText("he‮llo​\u0007 world\r\n\n\n\nok")).toBe("hello world\n\nok");
    });

    it("validates a dream", () => {
        const parsed = createDreamSchema.parse({
            title: "Help me pay my final-year fees",
            story: "I am one semester away from graduating and need help covering the remaining tuition balance.",
            category: "education",
            goalUsdc: "350",
            // An X link is never trusted at creation; it goes through the
            // verified /x flow, so it is stripped here.
            xPostUrl: "https://x.com/someone/status/1234567890",
        });
        expect(parsed.goalUsdc).toBe(350_000_000n);
        expect("xPostUrl" in parsed).toBe(false);
    });

    it("rejects out-of-range goals", () => {
        const base = { title: "A valid title", story: "x".repeat(50), category: "rent" };
        expect(createDreamSchema.safeParse({ ...base, goalUsdc: "0.5" }).success).toBe(false);
        expect(createDreamSchema.safeParse({ ...base, goalUsdc: "2000000" }).success).toBe(false);
    });

    it("normalizes coin symbols and rejects lookalikes", () => {
        expect(prepareCoinSchema.parse({ name: "Ada's Fees", symbol: "$ada" }).symbol).toBe("ADA");
        expect(prepareCoinSchema.safeParse({ name: "X", symbol: "ADA" }).success).toBe(false);
        expect(prepareCoinSchema.safeParse({ name: "Fine", symbol: "АDA" }).success).toBe(false); // Cyrillic А
    });

    it("parses swap amounts as bigint", () => {
        expect(swapSchema.parse({ side: "buy", amountIn: "100000000" }).amountIn).toBe(100_000_000n);
        expect(swapSchema.safeParse({ side: "buy", amountIn: "0" }).success).toBe(false);
    });
});

describe("dream curve", () => {
    it("routes most trading fees to the owner and locks all liquidity", () => {
        const curve = buildDreamCurve();
        expect(curve.creatorTradingFeePercentage).toBe(CREATOR_FEE_PERCENT);
        expect(curve.creatorPermanentLockedLiquidityPercentage + curve.partnerPermanentLockedLiquidityPercentage).toBe(100);
        expect(curve.creatorLiquidityPercentage + curve.partnerLiquidityPercentage).toBe(0);
        expect(curve.curve.length).toBeGreaterThan(0);
    });

    it("rejects nonsensical market caps", () => {
        expect(() => buildDreamCurve({ initialMarketCapSol: 100, migrationMarketCapSol: 50 })).toThrow();
    });
});
