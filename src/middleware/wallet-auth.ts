/**
 * Wallet auth middleware.
 *
 * Reuses the exact Dream worker scheme so the app does not need a second auth
 * implementation for the new backend.
 *
 * Message: `dream-ai:<walletAddress>:<timestampMs>`
 * Headers:
 *   X-Wallet-Address
 *   X-Wallet-Signature  (base64 Ed25519)
 *   X-Timestamp         (ms, 5-minute window)
 */

import { createMiddleware } from "hono/factory";
import bs58 from "bs58";
import nacl from "tweetnacl";

export type WalletAuthEnv = {
    Variables: {
        walletAddress: string;
    };
};

/** Verify the Dream wallet-signature headers and expose walletAddress. */
export const walletAuth = createMiddleware<WalletAuthEnv>(async (c, next) => {
    const address = c.req.header("X-Wallet-Address");
    const signature = c.req.header("X-Wallet-Signature");
    const timestamp = c.req.header("X-Timestamp");

    if (!address || !signature || !timestamp) {
        return c.json({ error: "Missing auth headers" }, 401);
    }

    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
        return c.json({ error: "Timestamp expired or invalid" }, 401);
    }

    let pubkeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
        pubkeyBytes = bs58.decode(address);
        signatureBytes = Uint8Array.from(Buffer.from(signature, "base64"));
    } catch {
        return c.json({ error: "Invalid auth encoding" }, 401);
    }

    const message = new TextEncoder().encode(`dream-ai:${address}:${timestamp}`);
    const valid = nacl.sign.detached.verify(message, signatureBytes, pubkeyBytes);
    if (!valid) {
        return c.json({ error: "Signature verification failed" }, 401);
    }

    c.set("walletAddress", address);
    await next();
});
