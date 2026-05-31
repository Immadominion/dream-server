/**
 * PhoenixOrderService — builds an order and executes it on the follower's
 * behalf by signing + broadcasting through Privy's server signer.
 *
 * This is the single entry point the orchestrator uses to mirror a leader's
 * trade. It never touches private keys: the transaction is signed by the
 * user's embedded wallet via Privy, constrained by the Phoenix-only policy.
 */

import { logger } from "../logger.js";
import { privySigner } from "../privy/privy-signer.js";
import { buildMarketOrder } from "./order-builder.js";

const log = logger.child({ module: "phoenix-order-service" });

export interface PlaceOrderParams {
    /** Privy wallet id used to sign on the follower's behalf. */
    privyWalletId: string;
    /** Follower wallet address (Phoenix authority + fee payer). */
    authority: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    transferAmountUsdc?: number;
    stopLossPrice?: number;
    slippageBps?: number;
}

export interface OrderResult {
    success: boolean;
    txSignature?: string;
    error?: string;
    estimatedLiquidationPrice?: number;
}

/** Build → sign → broadcast a market order. Returns a structured result. */
export async function placeMarketOrder(
    params: PlaceOrderParams
): Promise<OrderResult> {
    try {
        const { transaction, estimatedLiquidationPrice } = await buildMarketOrder({
            authority: params.authority,
            symbol: params.symbol,
            side: params.side,
            quantity: params.quantity,
            transferAmountUsdc: params.transferAmountUsdc,
            stopLossPrice: params.stopLossPrice,
            slippageBps: params.slippageBps,
        });

        const txSignature = await privySigner.signAndSendTransaction(
            params.privyWalletId,
            transaction
        );

        log.info(
            { authority: params.authority, symbol: params.symbol, txSignature },
            "order submitted"
        );
        return { success: true, txSignature, estimatedLiquidationPrice };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ authority: params.authority, symbol: params.symbol, error }, "order failed");
        return { success: false, error };
    }
}

/** Close an open position by placing a reverse market order (free). */
export async function closePosition(params: {
    privyWalletId: string;
    authority: string;
    symbol: string;
    positionSide: "long" | "short";
    sizeBase: number;
}): Promise<OrderResult> {
    const closeSide = params.positionSide === "long" ? "sell" : "buy";
    return placeMarketOrder({
        privyWalletId: params.privyWalletId,
        authority: params.authority,
        symbol: params.symbol,
        side: closeSide,
        quantity: params.sizeBase,
    });
}
