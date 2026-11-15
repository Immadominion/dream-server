/**
 * Dream's Meteora DBC launch economics — one config shared by every dream coin.
 *
 * Fee flow per trade (Meteora protocol takes 20% of trading fees off the top):
 *   remaining 80% → creatorTradingFeePercentage to the dream owner,
 *                   the rest to Dream (partner).
 * With CREATOR_FEE_PERCENT = 80 the person in need gets 64% of all trading
 * fees, Dream 16%, Meteora 20%.
 *
 * Liquidity at graduation (DAMM v2) is 100% permanently locked — nobody can
 * pull it — and split 80/20 owner/Dream, so LP fees keep flowing to the owner
 * after migration via the position NFT they receive.
 *
 * Supply/mint authority is immutable: no one (including Dream) can mint more.
 */

import {
    ActivationType,
    BaseFeeMode,
    CollectFeeMode,
    MigrationFeeOption,
    MigrationOption,
    TokenAuthorityOption,
    TokenDecimal,
    TokenType,
    buildCurveWithMarketCap,
    type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export interface DreamCurveOptions {
    /** Market cap (in SOL) at launch. */
    initialMarketCapSol: number;
    /** Market cap (in SOL) at which the curve completes and migrates. */
    migrationMarketCapSol: number;
}

export const DEFAULT_CURVE_OPTIONS: DreamCurveOptions = {
    initialMarketCapSol: 30,
    migrationMarketCapSol: 420,
};

export const CREATOR_FEE_PERCENT = 80;
export const TOTAL_SUPPLY = 1_000_000_000;

/** Steady-state trading fee: 1%. */
export const ENDING_FEE_BPS = 100;
/**
 * Anti-sniper: fee starts at 10% and decays to 1% over the first 60 seconds.
 * High enough to tax first-block bots, low enough that real supporters who buy
 * right after the owner shares the launch are not punished.
 */
export const STARTING_FEE_BPS = 1000;
export const FEE_DECAY_SECONDS = 60;

export function buildDreamCurve(options: DreamCurveOptions = DEFAULT_CURVE_OPTIONS): ConfigParameters {
    if (!(options.initialMarketCapSol > 0) || options.migrationMarketCapSol <= options.initialMarketCapSol) {
        throw new Error("migrationMarketCapSol must exceed initialMarketCapSol > 0");
    }
    return buildCurveWithMarketCap({
        token: {
            tokenType: TokenType.SPLToken,
            tokenBaseDecimal: TokenDecimal.SIX,
            tokenQuoteDecimal: 9, // SOL
            tokenAuthorityOption: TokenAuthorityOption.Immutable,
            totalTokenSupply: TOTAL_SUPPLY,
            leftover: 0,
        },
        fee: {
            baseFeeParams: {
                baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
                feeSchedulerParam: {
                    startingFeeBps: STARTING_FEE_BPS,
                    endingFeeBps: ENDING_FEE_BPS,
                    numberOfPeriod: 30,
                    totalDuration: FEE_DECAY_SECONDS,
                },
            },
            dynamicFeeEnabled: true,
            collectFeeMode: CollectFeeMode.QuoteToken, // fees paid in SOL
            creatorTradingFeePercentage: CREATOR_FEE_PERCENT,
            poolCreationFee: 0,
            enableFirstSwapWithMinFee: false,
        },
        migration: {
            migrationOption: MigrationOption.MET_DAMM_V2,
            migrationFeeOption: MigrationFeeOption.FixedBps100,
            migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        },
        liquidityDistribution: {
            partnerPermanentLockedLiquidityPercentage: 100 - CREATOR_FEE_PERCENT,
            partnerLiquidityPercentage: 0,
            creatorPermanentLockedLiquidityPercentage: CREATOR_FEE_PERCENT,
            creatorLiquidityPercentage: 0,
        },
        lockedVesting: {
            totalLockedVestingAmount: 0,
            numberOfVestingPeriod: 0,
            cliffUnlockAmount: 0,
            totalVestingDuration: 0,
            cliffDurationFromMigrationTime: 0,
        },
        activationType: ActivationType.Timestamp,
        initialMarketCap: options.initialMarketCapSol,
        migrationMarketCap: options.migrationMarketCapSol,
    });
}
