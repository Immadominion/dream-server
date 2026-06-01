import config from "../config.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "copy-notifications" });
let hasLoggedNotificationBridgeDisabled = false;

type CopyExecutionNotification = {
    followerWallet: string;
    leaderWallet: string;
    market: string;
    leaderSide: "long" | "short";
    changeType: "opened" | "increased" | "closed";
    notionalUsdc: number;
    txSignature: string;
};

type NotificationEventRow = {
    source: string;
    source_event_id: string;
    wallet_address: string;
    email_address: string | null;
    event_type: string;
    category: "intelligence";
    title: string;
    body: string;
    symbol: string;
    channels: string[];
    payload: Record<string, unknown>;
};

function isConfigured(): boolean {
    return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
}

function dispatchFunctionUrl(): string {
    return new URL("/functions/v1/dispatch-notifications", config.SUPABASE_URL).toString();
}

function shortWallet(address: string): string {
    if (address.length <= 10) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function baseSymbol(market: string): string {
    return market.replace(/-PERP$/i, "");
}

function formatUsd(amount: number): string {
    return amount >= 100 ? `$${amount.toFixed(0)}` : `$${amount.toFixed(2)}`;
}

function normalizeHeaderSecret(value: string): string {
    return value.replace(/\s+/g, "");
}

function buildCopyEvent(input: CopyExecutionNotification): NotificationEventRow {
    const sideLabel = input.leaderSide === "long" ? "Long" : "Short";
    const symbol = baseSymbol(input.market);
    const leader = shortWallet(input.leaderWallet);

    let title = `Copy trade updated · ${symbol} ${sideLabel}`;
    let body = `Mirrored activity from ${leader} on ${input.market}.`;

    if (input.changeType === "opened") {
        title = `Copy trade opened · ${symbol} ${sideLabel}`;
        body = `Mirrored ${formatUsd(input.notionalUsdc)} from ${leader} on ${input.market}.`;
    } else if (input.changeType === "increased") {
        title = `Copy trade increased · ${symbol} ${sideLabel}`;
        body = `Added ${formatUsd(input.notionalUsdc)} while mirroring ${leader}.`;
    } else if (input.changeType === "closed") {
        title = `Copy trade closed · ${symbol} ${sideLabel}`;
        body = `The copied ${symbol} ${sideLabel.toLowerCase()} position from ${leader} was closed.`;
    }

    return {
        source: "dream-server",
        source_event_id: `copy:${input.changeType}:${input.followerWallet}:${input.market}:${input.txSignature}`,
        wallet_address: input.followerWallet,
        email_address: null,
        event_type: `copy_trade_${input.changeType}`,
        category: "intelligence",
        title,
        body,
        symbol: input.market,
        channels: ["push"],
        payload: {
            copyTrade: true,
            symbol: input.market,
            leaderWallet: input.leaderWallet,
            leaderSide: input.leaderSide,
            changeType: input.changeType,
            notionalUsdc: input.notionalUsdc,
            txSignature: input.txSignature,
        },
    };
}

export async function enqueueCopyExecutionNotification(
    input: CopyExecutionNotification
): Promise<void> {
    if (!isConfigured()) {
        if (!hasLoggedNotificationBridgeDisabled) {
            hasLoggedNotificationBridgeDisabled = true;
            log.warn(
                "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset; copy-trade push notifications are disabled"
            );
        }
        return;
    }

    try {
        const response = await fetch(
            `${config.SUPABASE_URL}/rest/v1/notification_events?on_conflict=source,source_event_id`,
            {
                method: "POST",
                headers: {
                    apikey: config.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
                    "Content-Type": "application/json",
                    Prefer: "resolution=merge-duplicates,return=minimal",
                },
                body: JSON.stringify(buildCopyEvent(input)),
            }
        );

        if (!response.ok) {
            const responseText = await response.text();
            log.warn(
                {
                    status: response.status,
                    response: responseText,
                    followerWallet: input.followerWallet,
                    market: input.market,
                },
                "failed to enqueue copy notification"
            );
            return;
        }

        log.info(
            {
                followerWallet: input.followerWallet,
                market: input.market,
                changeType: input.changeType,
            },
            "copy notification enqueued"
        );

        await triggerCopyNotificationDispatch({
            followerWallet: input.followerWallet,
            market: input.market,
        });
    } catch (err) {
        log.warn(
            { err, followerWallet: input.followerWallet, market: input.market },
            "copy notification enqueue failed"
        );
    }
}

async function triggerCopyNotificationDispatch(input: {
    followerWallet: string;
    market: string;
}): Promise<void> {
    try {
        const headers: Record<string, string> = {
            apikey: config.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
        };

        const dispatchSecret = normalizeHeaderSecret(config.NOTIFICATION_DISPATCH_SECRET);
        if (dispatchSecret) {
            headers["x-webhook-secret"] = dispatchSecret;
        }

        const response = await fetch(dispatchFunctionUrl(), {
            method: "POST",
            headers,
            body: JSON.stringify({ source: "dream-server" }),
        });

        if (!response.ok) {
            const responseText = await response.text();
            log.warn(
                {
                    status: response.status,
                    response: responseText,
                    followerWallet: input.followerWallet,
                    market: input.market,
                },
                "copy notification dispatch trigger failed"
            );
            return;
        }

        const responseText = await response.text();
        log.info(
            {
                followerWallet: input.followerWallet,
                market: input.market,
                response: responseText,
            },
            "copy notification dispatch triggered"
        );
    } catch (err) {
        log.warn(
            { err, followerWallet: input.followerWallet, market: input.market },
            "copy notification dispatch trigger errored"
        );
    }
}