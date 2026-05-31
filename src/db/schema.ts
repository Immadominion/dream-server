/**
 * Dream Server — Database schema (Drizzle ORM + PostgreSQL).
 *
 * Tables power the always-on copy engine:
 *  - follower_wallets: one row per managed embedded wallet delegated to the
 *      server signer. This is the durable record created by register-signer.
 *  - copy_subscriptions: one row per (follower wallet → leader) auto-copy link.
 *      Holds copy settings + the Privy wallet id used to sign server-side.
 *  - leader_snapshots: last-known open positions per leader, used to diff new
 *      leader activity into copy actions (opened / increased / closed).
 *  - mirror_executions: append-only log of every mirror we attempted, with the
 *      resulting tx signature or error — the audit trail for user trust.
 *
 * Custody note: we never store private keys. The server signs through Privy
 * using an authorization key constrained by a Phoenix-only policy; the only
 * per-user identifier we persist is the user's Privy walletId.
 */

import {
  pgTable,
  text,
  serial,
  bigint,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════
// follower_wallets
// ═══════════════════════════════════════════════════════════════

export const followerWallets = pgTable(
  "follower_wallets",
  {
    /** Follower's Solana wallet address (also Phoenix authority). */
    followerWallet: text("follower_wallet").primaryKey(),
    /** Privy embedded wallet id that the server signs with. */
    privyWalletId: text("privy_wallet_id").notNull(),
    /** active | revoked — revoked means the signer consent was removed. */
    signerStatus: text("signer_status").notNull().default("active"),
    /**
     * Global copy-points balance for this follower. Opens consume one point
     * across all followed leaders; closes are free. This is the single source
     * of truth for credits (Postgres), replacing the old per-subscription pool.
     */
    points: bigint("points", { mode: "number" }).notNull().default(0),
    /** Last time the user explicitly consented on-device. */
    lastConsentAt: timestamp("last_consent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("follower_wallet_signer_status_idx").on(t.signerStatus)]
);

export type FollowerWalletRow = typeof followerWallets.$inferSelect;
export type NewFollowerWallet = typeof followerWallets.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// copy_subscriptions
// ═══════════════════════════════════════════════════════════════

export const copySubscriptions = pgTable(
  "copy_subscriptions",
  {
    id: serial("id").primaryKey(),
    /** Follower's Solana wallet address (Phoenix authority + fee payer). */
    followerWallet: text("follower_wallet").notNull(),
    /** Privy wallet id for the follower's embedded wallet (used to sign). */
    privyWalletId: text("privy_wallet_id").notNull(),
    /** Leader (broadcaster) Solana wallet address being copied. */
    leaderWallet: text("leader_wallet").notNull(),
    /** Copy settings: { copyUSDC, maxSlippage, stopLossRatio }. */
    settings: jsonb("settings").notNull(),
    /** active | paused — paused links are kept but not watched. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("copy_sub_follower_leader_uq").on(t.followerWallet, t.leaderWallet),
    index("copy_sub_status_idx").on(t.status),
    index("copy_sub_leader_idx").on(t.leaderWallet),
  ]
);

export type CopySubscriptionRow = typeof copySubscriptions.$inferSelect;
export type NewCopySubscription = typeof copySubscriptions.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// leader_snapshots
// ═══════════════════════════════════════════════════════════════

export const leaderSnapshots = pgTable(
  "leader_snapshots",
  {
    leaderWallet: text("leader_wallet").primaryKey(),
    /** Array of { market, side, size, entryPrice } captured last poll. */
    positions: jsonb("positions").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

export type LeaderSnapshotRow = typeof leaderSnapshots.$inferSelect;

// ═══════════════════════════════════════════════════════════════
// mirror_executions
// ═══════════════════════════════════════════════════════════════

export const mirrorExecutions = pgTable(
  "mirror_executions",
  {
    id: serial("id").primaryKey(),
    followerWallet: text("follower_wallet").notNull(),
    leaderWallet: text("leader_wallet").notNull(),
    market: text("market").notNull(),
    /** opened | increased | closed */
    changeType: text("change_type").notNull(),
    /** buy | sell — the side we placed on the follower's behalf. */
    side: text("side").notNull(),
    quantity: doublePrecision("quantity").notNull().default(0),
    notionalUsdc: doublePrecision("notional_usdc").notNull().default(0),
    success: boolean("success").notNull(),
    txSignature: text("tx_signature"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mirror_exec_follower_idx").on(t.followerWallet),
    index("mirror_exec_created_idx").on(t.createdAt),
  ]
);

export type MirrorExecutionRow = typeof mirrorExecutions.$inferSelect;
export type NewMirrorExecution = typeof mirrorExecutions.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// point_purchases
// ═══════════════════════════════════════════════════════════════

/**
 * Append-only ledger of verified SOL → copy-points top-ups. Keyed by the
 * on-chain tx signature so a single payment can never be credited twice
 * (replay protection). The credit route only inserts a row after it has
 * verified the payment landed in the treasury for a known tier amount.
 */
export const pointPurchases = pgTable("point_purchases", {
  /** Solana tx signature of the SOL transfer to the treasury. */
  txSignature: text("tx_signature").primaryKey(),
  /** Follower wallet that paid (and is credited). */
  followerWallet: text("follower_wallet").notNull(),
  /** Points granted for this purchase. */
  credits: bigint("credits", { mode: "number" }).notNull(),
  /** Lamports transferred to the treasury, for audit. */
  lamports: bigint("lamports", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PointPurchaseRow = typeof pointPurchases.$inferSelect;
