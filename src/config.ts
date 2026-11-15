/**
 * Dream Server — environment configuration with Zod validation.
 *
 * All env vars are validated at startup. Missing/invalid values exit the
 * process immediately with a clear message. Production adds extra guards so
 * the always-on signer never runs with unsafe defaults.
 */

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
    PORT: z.coerce.number().default(3002),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("info"),
    CORS_ORIGINS: z.string().default("*"),

    DATABASE_URL: z
        .string()
        .default("postgresql://localhost:5432/dream_dev"),

    SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
    SOLANA_CAIP2: z
        .string()
        .default("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),

    PHOENIX_API_URL: z.string().url().default("https://perp-api.phoenix.trade"),
    FLIGHT_BUILDER_AUTHORITY: z.string().default(""),
    PHOENIX_PROGRAM_IDS: z.string().default(""),

    PRIVY_APP_ID: z.string().default(""),
    PRIVY_APP_SECRET: z.string().default(""),
    PRIVY_AUTHORIZATION_KEY: z.string().default(""),
    // Key-quorum ID the client attaches as an additional signer (on-device
    // consent via Privy `addSigner`). Paired with the authorization key above.
    PRIVY_SIGNER_ID: z.string().default(""),
    // Policy ID restricting the additional signer to Phoenix-only actions.
    PRIVY_PHOENIX_POLICY_ID: z.string().default(""),

    LEADER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(6000),
    DREAM_WORKER_URL: z.string().default(""),

    // Optional Supabase admin credentials used to enqueue copy-trade push
    // notifications into Dream's existing notification backend.
    SUPABASE_URL: z.string().default(""),
    SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
    NOTIFICATION_DISPATCH_SECRET: z.string().default(""),

    // Treasury wallet that receives SOL micropayments for copy-point top-ups.
    // The credit route verifies on-chain that the payment landed here before
    // crediting Postgres points.
    DREAM_TREASURY_ADDRESS: z.string().default(""),

    // Telegram bot integration (optional — analytics + slash commands).
    TELEGRAM_BOT_TOKEN: z.string().default(""),
    TELEGRAM_CHAT_ID: z.string().default(""),
    TELEGRAM_WEBHOOK_SECRET: z.string().default(""),

    // Real-money economics (basis points).
    // Builder fee = notional * BUILDER_FEE_BPS / 10_000
    // Broadcaster earns = builder_fee * BROADCASTER_SHARE_BPS / 10_000
    BUILDER_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(10),
    BROADCASTER_SHARE_BPS: z.coerce.number().int().min(0).max(10000).default(3000),
    PAYOUT_MIN_USD: z.coerce.number().default(5),

    // ── Copy trading (V1, retired in V2) ────────────────────────────────
    // The always-on copy engine and its routes only run when explicitly
    // enabled. V2 ships with it off; flip to "true" to bring it back.
    COPY_ENGINE_ENABLED: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),

    // ── Dreams (V2) ─────────────────────────────────────────────────────
    // Public origin this server is reachable at. Coin metadata URIs are
    // written on-chain and are immutable, so this must be a stable domain
    // you control (e.g. https://api.trydream.fun), not a Railway hostname.
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3002"),
    USDC_MINT: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    // Meteora DBC config account created by scripts/create-dream-dbc-config.ts.
    // Empty disables coin launches (the rest of Dreams still works).
    DREAM_DBC_CONFIG: z.string().default(""),
    // Default coin image when a dream has none (must be a permanent URL).
    DREAM_COIN_IMAGE_URL: z.string().url().default("https://trydream.fun/coin.png"),
    // Priority fee for server-built transactions (micro-lamports per CU).
    PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().min(0).default(50_000),
    // A dream is hidden from the public feed once this many distinct
    // wallets report it, pending manual review.
    DREAM_REPORT_HIDE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    // Max simultaneously open dreams per wallet (anti-spam).
    DREAM_MAX_OPEN_PER_WALLET: z.coerce.number().int().min(1).default(3),
    // A prepared launch older than this has an expired blockhash: it either
    // landed already or never will, so it gets reconciled against the chain.
    DREAM_STALE_LAUNCH_SECONDS: z.coerce.number().int().min(1).default(180),
    // HMAC secret for Dreams session tokens (≥32 chars). Required in production.
    DREAM_SESSION_SECRET: z.string().default(""),
    // Operator token for moderation endpoints (hide/unhide). Empty disables them.
    ADMIN_API_TOKEN: z.string().default(""),
    // Proxy entries at the end of X-Forwarded-For after the real client.
    // Railway (verified 2026-11-15) discards the client's header and sends
    // "<client>, <edge>" with a per-connection edge IP, so the client is the
    // 2nd entry from the right. Used to key rate limits.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("❌ Invalid environment variables:");
    console.error(parsed.error.format());
    process.exit(1);
}

if (parsed.data.NODE_ENV === "production") {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (
        parsed.data.DATABASE_URL.includes("localhost") ||
        parsed.data.DATABASE_URL.includes("127.0.0.1")
    ) {
        errors.push("DATABASE_URL points to localhost — set your production Postgres URL");
    }
    const copyEnabled = parsed.data.COPY_ENGINE_ENABLED;
    if (copyEnabled && (!parsed.data.PRIVY_APP_ID || !parsed.data.PRIVY_APP_SECRET)) {
        errors.push("PRIVY_APP_ID / PRIVY_APP_SECRET are required to sign server-side");
    }
    if (copyEnabled && !parsed.data.PRIVY_AUTHORIZATION_KEY) {
        errors.push(
            "PRIVY_AUTHORIZATION_KEY is required — the always-on signer cannot execute without it"
        );
    }
    if (copyEnabled && !parsed.data.PRIVY_SIGNER_ID) {
        errors.push(
            "PRIVY_SIGNER_ID is required — clients cannot attach the server signer without it"
        );
    }
    if (!parsed.data.DREAM_TREASURY_ADDRESS) {
        warnings.push(
            "DREAM_TREASURY_ADDRESS is unset — paid copy-point top-ups will be rejected"
        );
    }
    if (parsed.data.CORS_ORIGINS === "*") {
        warnings.push("CORS_ORIGINS is '*' — restrict to your app origins");
    }
    if (parsed.data.SOLANA_RPC_URL.includes("api.mainnet-beta.solana.com")) {
        warnings.push("SOLANA_RPC_URL is a public endpoint — use Helius/Triton for reliability");
    }
    if (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY) {
        warnings.push(
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset — mirrored copy-trade push notifications are disabled"
        );
    }

    if (parsed.data.PUBLIC_BASE_URL.includes("localhost")) {
        errors.push("PUBLIC_BASE_URL is localhost — coin metadata URIs would be unreachable");
    }
    if (parsed.data.PUBLIC_BASE_URL.includes(".up.railway.app")) {
        warnings.push(
            "PUBLIC_BASE_URL is a Railway hostname — coin metadata URIs are permanent; use your own domain"
        );
    }
    if (parsed.data.DREAM_SESSION_SECRET.length < 32) {
        errors.push("DREAM_SESSION_SECRET must be set (≥32 random chars) — Dreams auth tokens depend on it");
    }
    if (parsed.data.ADMIN_API_TOKEN && parsed.data.ADMIN_API_TOKEN.length < 32) {
        errors.push("ADMIN_API_TOKEN must be ≥32 random chars when set");
    }
    if (!parsed.data.DREAM_DBC_CONFIG) {
        warnings.push("DREAM_DBC_CONFIG unset — dream coin launches are disabled");
    }

    for (const w of warnings) console.warn(`⚠️  ${w}`);
    if (errors.length > 0) {
        console.error("❌ Production configuration errors:");
        for (const e of errors) console.error(`   • ${e}`);
        process.exit(1);
    }
}

/** Phoenix program ids the server signer is allowed to touch (custody guard). */
export const phoenixProgramIds = parsed.data.PHOENIX_PROGRAM_IDS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export type Config = z.infer<typeof envSchema>;
export const config: Config = parsed.data;
export default config;
