/**
 * Shared Phoenix types for the copy engine (server-side port of the Dream
 * client models — only the fields the engine needs to diff + mirror).
 */

/** A leader's open position, normalised for diffing. */
export interface LeaderPosition {
    market: string;
    side: "long" | "short";
    size: number;
    entryPrice: number;
}

/** Copy settings persisted per subscription. */
export interface CopySettings {
    copyUSDC: number;
    maxSlippage: number; // e.g. 0.005 = 0.5%
    stopLossRatio: number; // e.g. 0.20 = 20%
}

export const defaultCopySettings: CopySettings = {
    copyUSDC: 50,
    maxSlippage: 0.005,
    stopLossRatio: 0.2,
};

/** Coerce unknown JSON/DB payloads into valid copy settings with defaults. */
export function normalizeCopySettings(input: unknown): CopySettings {
    if (!input || typeof input !== "object") {
        return { ...defaultCopySettings };
    }

    const raw = input as Record<string, unknown>;
    const copyUSDC = Number(raw.copyUSDC);
    const maxSlippage = Number(raw.maxSlippage);
    const stopLossRatio = Number(raw.stopLossRatio);

    return {
        copyUSDC: Number.isFinite(copyUSDC) && copyUSDC > 0 ? copyUSDC : defaultCopySettings.copyUSDC,
        maxSlippage:
            Number.isFinite(maxSlippage) && maxSlippage >= 0
                ? maxSlippage
                : defaultCopySettings.maxSlippage,
        stopLossRatio:
            Number.isFinite(stopLossRatio) && stopLossRatio >= 0
                ? stopLossRatio
                : defaultCopySettings.stopLossRatio,
    };
}

/** A single Phoenix instruction as returned by the order-build endpoint. */
export interface PhoenixInstruction {
    programId: string;
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: number[];
}

export interface PhoenixEnhancedOrderResponse {
    instructions: PhoenixInstruction[];
    estimatedLiquidationPrice?: number;
}
