/**
 * Fixed-window rate limiter (in-memory, per process).
 *
 * Keys combine the route bucket with the caller's IP and, when authenticated,
 * their wallet — so rotating wallets doesn't escape the IP limit and sharing
 * an IP (mobile carrier NAT) doesn't let one wallet starve others.
 *
 * Single-instance Railway deployment makes in-memory state sufficient; move
 * to Redis/Postgres if the server is ever scaled horizontally.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

interface Window {
    count: number;
    resetAt: number;
}

const windows = new Map<string, Window>();
let lastSweep = Date.now();

function sweep(now: number): void {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export function clientIp(c: Context): string {
    // Railway terminates TLS and appends the client IP; take the first hop.
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || c.req.header("x-real-ip") || "unknown";
}

function hit(key: string, limit: number, windowMs: number, now: number): number | null {
    const w = windows.get(key);
    if (!w || w.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return null;
    }
    w.count += 1;
    return w.count > limit ? Math.ceil((w.resetAt - now) / 1000) : null;
}

/**
 * Limit a route to [perIp] requests per window per IP and, if a wallet is
 * known (after auth), [perWallet] per wallet.
 */
export function rateLimit(bucket: string, opts: { windowMs: number; perIp: number; perWallet?: number }) {
    return createMiddleware<{ Variables: { walletAddress?: string } }>(async (c, next) => {
        const now = Date.now();
        sweep(now);
        const ip = clientIp(c);
        let retryAfter = hit(`${bucket}:ip:${ip}`, opts.perIp, opts.windowMs, now);
        const wallet = c.get("walletAddress");
        if (retryAfter === null && wallet && opts.perWallet) {
            retryAfter = hit(`${bucket}:w:${wallet}`, opts.perWallet, opts.windowMs, now);
        }
        if (retryAfter !== null) {
            c.header("Retry-After", String(retryAfter));
            return c.json({ error: "Too many requests — slow down and try again shortly" }, 429);
        }
        await next();
    });
}

/** Test helper. */
export function resetRateLimits(): void {
    windows.clear();
}
