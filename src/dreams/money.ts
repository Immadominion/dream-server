/**
 * Integer money helpers. All USDC amounts are micro-USDC (6 decimals) held in
 * bigint so sums never drift. Values cross the API boundary as decimal
 * strings ("12.5") — never JS numbers — so large totals stay exact.
 */

export const USDC_DECIMALS = 6;
const MICRO_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** Smallest contribution we record (anti-dust): 0.01 USDC. */
export const MIN_CONTRIBUTION_MICRO = 10_000n;
/** Goal bounds: 1 USDC .. 1,000,000 USDC. */
export const MIN_GOAL_MICRO = 1n * MICRO_PER_USDC;
export const MAX_GOAL_MICRO = 1_000_000n * MICRO_PER_USDC;

/**
 * Parse a non-negative decimal USDC string ("25", "25.5", "0.000001") into
 * micro-USDC. Returns null for anything malformed or with >6 decimals.
 */
export function parseUsdc(input: string): bigint | null {
    const s = input.trim();
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
    if (!m) return null;
    const whole = BigInt(m[1]!);
    const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
    return whole * MICRO_PER_USDC + frac;
}

/** Format micro-USDC as a minimal decimal string ("25", "25.5"). */
export function formatUsdc(micro: bigint): string {
    const negative = micro < 0n;
    const abs = negative ? -micro : micro;
    const whole = abs / MICRO_PER_USDC;
    const frac = (abs % MICRO_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Lamports → SOL decimal string, exact. */
export function formatLamports(lamports: bigint): string {
    const LAMPORTS = 1_000_000_000n;
    const whole = lamports / LAMPORTS;
    const frac = (lamports % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""}`;
}
