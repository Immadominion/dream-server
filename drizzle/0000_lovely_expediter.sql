CREATE TABLE "copy_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"follower_wallet" text NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"leader_wallet" text NOT NULL,
	"settings" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follower_wallets" (
	"follower_wallet" text PRIMARY KEY NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"signer_status" text DEFAULT 'active' NOT NULL,
	"points" bigint DEFAULT 0 NOT NULL,
	"last_consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_snapshots" (
	"leader_wallet" text PRIMARY KEY NOT NULL,
	"positions" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"follower_wallet" text NOT NULL,
	"leader_wallet" text NOT NULL,
	"market" text NOT NULL,
	"change_type" text NOT NULL,
	"side" text NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"notional_usdc" double precision DEFAULT 0 NOT NULL,
	"success" boolean NOT NULL,
	"tx_signature" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "point_purchases" (
	"tx_signature" text PRIMARY KEY NOT NULL,
	"follower_wallet" text NOT NULL,
	"credits" bigint NOT NULL,
	"lamports" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "copy_sub_follower_leader_uq" ON "copy_subscriptions" USING btree ("follower_wallet","leader_wallet");--> statement-breakpoint
CREATE INDEX "copy_sub_status_idx" ON "copy_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "copy_sub_leader_idx" ON "copy_subscriptions" USING btree ("leader_wallet");--> statement-breakpoint
CREATE INDEX "follower_wallet_signer_status_idx" ON "follower_wallets" USING btree ("signer_status");--> statement-breakpoint
CREATE INDEX "mirror_exec_follower_idx" ON "mirror_executions" USING btree ("follower_wallet");--> statement-breakpoint
CREATE INDEX "mirror_exec_created_idx" ON "mirror_executions" USING btree ("created_at");