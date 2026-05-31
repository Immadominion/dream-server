/**
 * Telegram analytics + webhook routes.
 *
 * Public:
 *   POST /v1/analytics/event    — forward a push analytics event to Telegram
 *   POST /v1/telegram/webhook   — handle Telegram slash commands (bot webhook)
 *
 * The Telegram bot token never appears in the app. The app posts structured
 * events here; the server formats and forwards them. Analytics events are
 * subject to an in-memory per-wallet rate limit (200/hr) so a misbehaving
 * client cannot spam the developer chat.
 *
 * Slash commands (/stats, /fees, /ping, /help) are handled in the webhook
 * handler. Only messages from the configured TELEGRAM_CHAT_ID are processed.
 */

import { Hono } from "hono";
import config from "../config.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "analytics" });

const ANALYTICS_MAX_PER_WINDOW = 200;
const ANALYTICS_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PHOENIX_API = "https://perp-api.phoenix.trade";

// In-memory rate limit store: key → { count, windowStart }
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

// ── Exported helper so broadcasters.ts can send Telegram notifications ───────

export async function sendTelegram(text: string): Promise<void> {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;
    try {
        await fetch(
            `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: config.TELEGRAM_CHAT_ID,
                    text,
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                }),
            }
        );
    } catch (err) {
        log.warn({ err }, "Telegram sendMessage failed");
    }
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

function isRateLimited(key: string): boolean {
    const now = Date.now();
    const rec = rateLimitStore.get(key);
    if (!rec || now - rec.windowStart >= ANALYTICS_WINDOW_MS) {
        rateLimitStore.set(key, { count: 1, windowStart: now });
        return false;
    }
    if (rec.count >= ANALYTICS_MAX_PER_WINDOW) return true;
    rec.count += 1;
    return false;
}

// ── Event formatting ──────────────────────────────────────────────────────────

interface AnalyticsEvent {
    type: string;
    wallet?: string;
    data?: Record<string, unknown>;
}

function str(v: unknown): string {
    return v == null ? "" : String(v);
}
function num(v: unknown, dp: number): string {
    return (Number(v) || 0).toFixed(dp);
}
function nowUtc(): string {
    const n = new Date();
    const p = (x: number) => x.toString().padStart(2, "0");
    return `${n.getUTCFullYear()}-${p(n.getUTCMonth() + 1)}-${p(n.getUTCDate())} ${p(n.getUTCHours())}:${p(n.getUTCMinutes())} UTC`;
}

function formatAnalyticsEvent(evt: AnalyticsEvent): string | null {
    const d = evt.data ?? {};
    switch (evt.type) {
        case "new_user":
            return `🆕 *New User*\n\`${str(d.wallet)}\`\n🕐 ${nowUtc()}`;

        case "order_opened": {
            const side = str(d.side);
            const emoji = side === "buy" ? "🟢" : "🔴";
            const dir = side === "buy" ? "LONG" : "SHORT";
            const typeLabel = str(d.orderType) === "market" ? "Market" : "Limit";
            return (
                `${emoji} *Trade Opened* — ${typeLabel}\n` +
                `📊 \`${str(d.symbol)}\` · *${dir}* · ${num(d.leverage, 0)}x\n` +
                `💵 Collateral: $${num(d.sizeUsdc, 2)} USDC\n` +
                `📐 Notional: $${num(d.notionalUsdc, 2)} USDC\n` +
                `🎯 Entry: $${num(d.entryPrice, 4)}\n` +
                `🔗 [View TX](https://solscan.io/tx/${str(d.txSignature)})`
            );
        }

        case "position_closed": {
            const side = str(d.side);
            const pnl = d.pnlUsdc;
            const pnlStr =
                typeof pnl === "number"
                    ? pnl >= 0
                        ? `✅ +$${pnl.toFixed(2)}`
                        : `❌ $${pnl.toFixed(2)}`
                    : "N/A";
            return (
                `🔒 *Position Closed*\n` +
                `📊 \`${str(d.symbol)}\` · ${side === "buy" ? "LONG" : "SHORT"}\n` +
                `💸 PnL: ${pnlStr}`
            );
        }

        case "collateral_deposit":
            return (
                `💰 *Collateral Deposit*\n` +
                `👛 \`${str(d.wallet).slice(0, 8)}...${str(d.wallet).slice(-4)}\`\n` +
                `💵 $${num(d.amountUsdc, 2)} USDC`
            );

        default:
            return null;
    }
}

// ── Slash commands ────────────────────────────────────────────────────────────

function fmtPrice(v: unknown): string {
    const d = Number(v) || 0;
    return d >= 1000 ? d.toFixed(2) : d.toFixed(d < 1 ? 4 : 2);
}
function fmtVol(v: unknown): string {
    const d = Number(v) || 0;
    if (d >= 1e9) return `${(d / 1e9).toFixed(1)}B`;
    if (d >= 1e6) return `${(d / 1e6).toFixed(1)}M`;
    if (d >= 1e3) return `${(d / 1e3).toFixed(1)}K`;
    return d.toFixed(0);
}

async function handleStatsCommand(): Promise<void> {
    try {
        const res = await fetch(`${PHOENIX_API}/exchange/markets`);
        const markets = ((await res.json()) as Array<Record<string, unknown>>) ?? [];
        let out = "📊 *Phoenix Markets*\n\n";
        for (const m of markets.slice(0, 5)) {
            const symbol = m.symbol ?? m.marketId ?? "?";
            const price = m.markPrice ?? m.indexPrice ?? m.lastPrice ?? 0;
            const change = m.priceChange24h ?? m.change24h;
            const vol = m.volume24hUsd ?? m.volume24h;
            let changeStr = "";
            if (change != null) {
                const dn = Number(change) || 0;
                changeStr = dn >= 0 ? ` ▲${dn.toFixed(2)}%` : ` ▼${Math.abs(dn).toFixed(2)}%`;
            }
            const volStr = vol != null ? ` · Vol $${fmtVol(vol)}` : "";
            out += `\`${symbol}\` $${fmtPrice(price)}${changeStr}${volStr}\n`;
        }
        out += `\n🕐 ${nowUtc()}`;
        await sendTelegram(out);
    } catch {
        await sendTelegram("⚠️ Could not fetch market data");
    }
}

async function handleFeesCommand(): Promise<void> {
    const authority = config.FLIGHT_BUILDER_AUTHORITY;
    if (!authority) {
        await sendTelegram("⚠️ FLIGHT\\_BUILDER\\_AUTHORITY not configured");
        return;
    }
    try {
        const res = await fetch(`${PHOENIX_API}/trader/${authority}/state`);
        const data = ((await res.json()) as Record<string, unknown>) ?? {};
        const collateral = data.collateral ?? data.availableCollateral ?? 0;
        const pnl = data.unrealizedPnl ?? data.pnl ?? 0;
        await sendTelegram(
            `🏦 *Builder Fee Account*\n` +
            `👛 \`${authority.slice(0, 6)}...${authority.slice(-4)}\`\n` +
            `💵 Collateral: $${fmtPrice(collateral)} USDC\n` +
            `📈 Unrealized PnL: $${fmtPrice(pnl)}\n` +
            `🕐 ${nowUtc()}`
        );
    } catch {
        await sendTelegram("⚠️ Could not fetch builder fee data");
    }
}

async function handleCommand(text: string): Promise<void> {
    if (text === "/start" || text === "/help") {
        await sendTelegram(
            "🤖 *Dream Terminal Analytics*\n\n" +
            "/stats — Live Phoenix market overview\n" +
            "/fees — Builder fee account status\n" +
            "/ping — Health check\n" +
            "/help — This message"
        );
    } else if (text === "/ping") {
        await sendTelegram(`✅ Dream Terminal is live\n🕐 ${nowUtc()}`);
    } else if (text === "/stats") {
        await handleStatsCommand();
    } else if (text === "/fees") {
        await handleFeesCommand();
    }
}

// ── Route handlers ────────────────────────────────────────────────────────────

export const analyticsRoutes = new Hono();

analyticsRoutes.post("/event", async (c) => {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        return c.json({ ok: true, skipped: "telegram_not_configured" });
    }

    let body: AnalyticsEvent;
    try {
        body = await c.req.json<AnalyticsEvent>();
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.type) return c.json({ error: "Missing event type" }, 400);

    const rlKey = `tgrl:${body.wallet ?? "anon"}`;
    if (isRateLimited(rlKey)) {
        return c.json({ ok: true, skipped: "rate_limited" });
    }

    const text = formatAnalyticsEvent(body);
    if (text) void sendTelegram(text);
    return c.json({ ok: true });
});

export const telegramRoutes = new Hono();

telegramRoutes.post("/webhook", async (c) => {
    if (config.TELEGRAM_WEBHOOK_SECRET) {
        const provided = c.req.header("X-Telegram-Bot-Api-Secret-Token");
        if (provided !== config.TELEGRAM_WEBHOOK_SECRET) {
            return c.text("forbidden", 403);
        }
    }

    let update: { message?: { chat?: { id?: number }; text?: string } };
    try {
        update = await c.req.json();
    } catch {
        return c.text("ok"); // never make Telegram retry on bad input
    }

    const msg = update.message;
    const chatId = msg?.chat?.id;
    if (!msg || String(chatId) !== String(config.TELEGRAM_CHAT_ID)) {
        return c.text("ok");
    }

    const text = (msg.text ?? "").trim().toLowerCase();
    void handleCommand(text);
    return c.text("ok");
});
