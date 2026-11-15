/**
 * Request schemas + text sanitation for Dreams.
 *
 * Text is stored as plain text and rendered as plain text by the app, so we
 * don't HTML-escape — we strip control/bidi characters (spoofing vectors),
 * collapse runs of blank lines, and enforce hard length limits.
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { DREAM_CATEGORIES } from "../db/schema.js";
import { MAX_GOAL_MICRO, MIN_GOAL_MICRO, parseUsdc } from "./money.js";

// C0/C1 controls (except \n, \t), soft hyphen, Arabic letter mark, Hangul
// fillers, zero-width/joiner/bidi marks, line/paragraph separators, word
// joiner & invisible operators, bidi isolates, BOM, and Unicode tag chars.
const UNSAFE_CHARS =
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u3164\uFFA0\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

export function cleanText(input: string): string {
    return input
        .replace(/\r\n?/g, "\n")
        .replace(UNSAFE_CHARS, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function isValidPublicKey(value: string): boolean {
    try {
        // Round-trip guards against inputs PublicKey accepts but normalizes.
        return new PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

const cleanedString = (min: number, max: number) =>
    z
        .string()
        .transform(cleanText)
        .pipe(z.string().min(min).max(max));

const usdcAmount = (min: bigint, max: bigint) =>
    z.string().transform((value, ctx) => {
        const micro = parseUsdc(value);
        if (micro === null || micro < min || micro > max) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid USDC amount" });
            return z.NEVER;
        }
        return micro;
    });

export const createDreamSchema = z.object({
    title: cleanedString(8, 80),
    story: cleanedString(40, 2000),
    category: z.enum(DREAM_CATEGORIES),
    goalUsdc: usdcAmount(MIN_GOAL_MICRO, MAX_GOAL_MICRO),
});

/**
 * Owner edits. Title and goal are immutable; the story can only change while
 * nobody has funded the dream (no bait-and-switch). Linking X is a separate,
 * verified flow (POST /:id/x).
 */
export const updateDreamSchema = z
    .object({
        story: cleanedString(40, 2000).optional(),
        status: z.literal("closed").optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const linkXSchema = z.object({
    url: z.string().trim().max(200),
});

export const moderationSchema = z.object({
    hidden: z.boolean(),
});

export const listDreamsQuery = z.object({
    sort: z.enum(["new", "closest", "supported"]).default("new"),
    category: z.enum(DREAM_CATEGORIES).optional(),
    owner: z.string().refine(isValidPublicKey, "Invalid wallet").optional(),
    cursor: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const contributionSchema = z.object({
    txSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "Invalid signature"),
});

export const reportSchema = z.object({
    reason: z.enum(["scam", "fake", "offensive", "spam", "other"]),
});

/**
 * Coin name/symbol go on-chain via Metaplex (name ≤32 bytes, symbol ≤10).
 * Symbols are restricted to A–Z/0–9 so they can't impersonate with lookalikes.
 */
export const prepareCoinSchema = z.object({
    // Printable ASCII only: blocks homoglyph names (e.g. a Cyrillic "USDC").
    name: cleanedString(2, 32).pipe(z.string().regex(/^[\x20-\x7E]+$/, "Use letters, numbers and basic punctuation")),
    symbol: z
        .string()
        .trim()
        .transform((v) => v.replace(/^\$/, "").toUpperCase())
        .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, "Symbol must be 2–10 letters or digits")),
});

export const confirmCoinSchema = z.object({
    mint: z.string().refine(isValidPublicKey, "Invalid mint"),
    txSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "Invalid signature"),
});

export const swapSchema = z.object({
    side: z.enum(["buy", "sell"]),
    /** Raw integer amount of the input token (lamports for buy, base units for sell). */
    amountIn: z
        .string()
        .regex(/^\d{1,20}$/)
        .transform((v) => BigInt(v))
        .refine((v) => v > 0n && v <= 18_446_744_073_709_551_615n, "Invalid amount"),
    // 1% default; capped at 15% so a bad client can't authorize a near-unlimited sandwich.
    slippageBps: z.number().int().min(10).max(1500).default(100),
});
