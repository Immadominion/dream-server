/**
 * Dreams session auth.
 *
 * The legacy `dream-ai:<wallet>:<ts>` header scheme is shared with other Dream
 * services, signs nothing about the request, and accepts timestamps up to
 * 5 minutes in the future — so a leaked header works anywhere for ~10 minutes.
 * Dreams uses its own, domain-separated scheme instead:
 *
 *   1. The wallet signs `dream-session:v1:<wallet>:<timestampMs>` once
 *      (≤5 min old, ≤30 s in the future) and POSTs it to /v1/dreams/session.
 *   2. The server returns a short-lived bearer token:
 *        base64url({ w: wallet, exp, n: nonce }) + "." + HMAC-SHA256(secret)
 *   3. Every Dreams write sends `Authorization: Bearer <token>`.
 *
 * Signatures from other Dream services can never authenticate here, and a
 * wallet only signs once per session instead of once per request (important
 * for MWA wallets, where each signature is a wallet-app round trip).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import nacl from "tweetnacl";
import config from "../config.js";

export type DreamAuthEnv = { Variables: { walletAddress: string } };

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_PAST_SKEW_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

// Dev/test fall back to a per-process secret (sessions reset on restart);
// production refuses to boot without DREAM_SESSION_SECRET (see config.ts).
const secret = config.DREAM_SESSION_SECRET || randomBytes(32).toString("hex");

function b64url(buf: Buffer): string {
    return buf.toString("base64url");
}

function sign(payload: string): string {
    return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function sessionMessage(wallet: string, timestamp: string): string {
    return `dream-session:v1:${wallet}:${timestamp}`;
}

export class SessionError extends Error {}

/** Verify a wallet's session-request signature and mint a bearer token. */
export function issueSession(params: { wallet: string; signature: string; timestamp: string }): {
    token: string;
    expiresAt: string;
} {
    const ts = Number(params.timestamp);
    const now = Date.now();
    if (!/^\d{13}$/.test(params.timestamp) || now - ts > MAX_PAST_SKEW_MS || ts - now > MAX_FUTURE_SKEW_MS) {
        throw new SessionError("Timestamp expired or invalid");
    }

    let valid = false;
    try {
        const pubkey = bs58.decode(params.wallet);
        const sig = Buffer.from(params.signature, "base64");
        if (pubkey.length === 32 && sig.length === 64) {
            valid = nacl.sign.detached.verify(
                new TextEncoder().encode(sessionMessage(params.wallet, params.timestamp)),
                sig,
                pubkey
            );
        }
    } catch {
        valid = false;
    }
    if (!valid) throw new SessionError("Signature verification failed");

    const exp = now + SESSION_TTL_MS;
    const payload = b64url(Buffer.from(JSON.stringify({ w: params.wallet, exp, n: b64url(randomBytes(8)) })));
    return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
}

/** Returns the wallet for a valid, unexpired token, else null. */
export function verifySessionToken(token: string): string | null {
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
        const { w, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { w: unknown; exp: unknown };
        if (typeof w !== "string" || typeof exp !== "number" || exp < Date.now()) return null;
        return w;
    } catch {
        return null;
    }
}

export const dreamAuth = createMiddleware<DreamAuthEnv>(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const wallet = header.startsWith("Bearer ") ? verifySessionToken(header.slice(7).trim()) : null;
    if (!wallet) return c.json({ error: "Session expired — please try again" }, 401);
    c.set("walletAddress", wallet);
    await next();
});

/** Constant-time check of the operator token for moderation endpoints. */
export function isAdmin(c: Context): boolean {
    if (!config.ADMIN_API_TOKEN) return false;
    const header = c.req.header("Authorization") ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    const expected = Buffer.from(config.ADMIN_API_TOKEN);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
