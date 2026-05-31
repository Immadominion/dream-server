CREATE TABLE "broadcaster_copiers" (
	"broadcaster_address" text NOT NULL,
	"copier_address" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcaster_copiers_broadcaster_address_copier_address_pk" PRIMARY KEY("broadcaster_address","copier_address")
);
--> statement-breakpoint
CREATE TABLE "broadcaster_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"broadcaster_address" text NOT NULL,
	"type" text NOT NULL,
	"copier_address" text,
	"market" text,
	"side" text,
	"notional_usd" double precision,
	"builder_fee_usd" double precision,
	"earned_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcaster_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"broadcaster_address" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasters" (
	"address" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"strategy" text,
	"twitter" text,
	"revenue_share_bps" integer DEFAULT 3000 NOT NULL,
	"copier_count" integer DEFAULT 0 NOT NULL,
	"lifetime_usd" double precision DEFAULT 0 NOT NULL,
	"claimable_usd" double precision DEFAULT 0 NOT NULL,
	"paid_out_usd" double precision DEFAULT 0 NOT NULL,
	"fills_count" integer DEFAULT 0 NOT NULL,
	"volume_usd" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcaster_copiers" ADD CONSTRAINT "broadcaster_copiers_broadcaster_address_broadcasters_address_fk" FOREIGN KEY ("broadcaster_address") REFERENCES "public"."broadcasters"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcaster_earnings" ADD CONSTRAINT "broadcaster_earnings_broadcaster_address_broadcasters_address_fk" FOREIGN KEY ("broadcaster_address") REFERENCES "public"."broadcasters"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcaster_payouts" ADD CONSTRAINT "broadcaster_payouts_broadcaster_address_broadcasters_address_fk" FOREIGN KEY ("broadcaster_address") REFERENCES "public"."broadcasters"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcaster_copiers_broadcaster_idx" ON "broadcaster_copiers" USING btree ("broadcaster_address");--> statement-breakpoint
CREATE INDEX "broadcaster_earnings_address_idx" ON "broadcaster_earnings" USING btree ("broadcaster_address");--> statement-breakpoint
CREATE INDEX "broadcaster_earnings_created_idx" ON "broadcaster_earnings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "broadcaster_payouts_address_idx" ON "broadcaster_payouts" USING btree ("broadcaster_address");--> statement-breakpoint
CREATE INDEX "broadcaster_is_active_idx" ON "broadcasters" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "broadcaster_lifetime_usd_idx" ON "broadcasters" USING btree ("lifetime_usd");