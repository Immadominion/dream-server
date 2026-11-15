CREATE TABLE "dream_coin_launches" (
	"mint" text PRIMARY KEY NOT NULL,
	"dream_id" text NOT NULL,
	"pool" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_valid_block_height" bigint,
	"tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dream_contributions" (
	"tx_signature" text PRIMARY KEY NOT NULL,
	"dream_id" text NOT NULL,
	"contributor_wallet" text NOT NULL,
	"amount_usdc_micro" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dream_reports" (
	"dream_id" text NOT NULL,
	"reporter_wallet" text NOT NULL,
	"reason" text NOT NULL,
	"credible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dream_reports_dream_id_reporter_wallet_pk" PRIMARY KEY("dream_id","reporter_wallet")
);
--> statement-breakpoint
CREATE TABLE "dreams" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_wallet" text NOT NULL,
	"title" text NOT NULL,
	"story" text NOT NULL,
	"category" text NOT NULL,
	"goal_usdc_micro" bigint NOT NULL,
	"raised_usdc_micro" bigint DEFAULT 0 NOT NULL,
	"supporter_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"x_post_url" text,
	"x_handle" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"coin_mint" text,
	"coin_pool" text,
	"coin_symbol" text,
	"coin_launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dream_coin_launches" ADD CONSTRAINT "dream_coin_launches_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_contributions" ADD CONSTRAINT "dream_contributions_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_reports" ADD CONSTRAINT "dream_reports_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dream_coin_launch_dream_idx" ON "dream_coin_launches" USING btree ("dream_id");--> statement-breakpoint
CREATE INDEX "dream_contrib_dream_idx" ON "dream_contributions" USING btree ("dream_id","created_at");--> statement-breakpoint
CREATE INDEX "dream_contrib_wallet_idx" ON "dream_contributions" USING btree ("contributor_wallet");--> statement-breakpoint
CREATE INDEX "dreams_owner_idx" ON "dreams" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "dreams_feed_idx" ON "dreams" USING btree ("hidden","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dreams_coin_mint_uq" ON "dreams" USING btree ("coin_mint");