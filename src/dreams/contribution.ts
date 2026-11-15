/**
 * On-chain verification of wallet-to-wallet USDC contributions.
 *
 * Dream never holds supporter money: the app sends USDC straight from the
 * supporter's wallet to the dream owner's wallet, then hands us the tx
 * signature. We only credit the dream after proving, from the confirmed
 * transaction itself, that:
 *   - the transaction succeeded and is finalized/confirmed,
 *   - the authenticated supporter signed it,
 *   - the owner's USDC balance went up and the supporter's went down,
 *   - the owner did NOT co-sign it and the supporter got no tokens back in
 *     it (no same-transaction round trips that fake support),
 *   - it happened after the dream was created (no reusing old transfers).
 *
 * The credited amount is measured from pre/post token balances, which covers
 * every instruction shape (transfer, transferChecked, inner/CPI transfers)
 * without trusting the client's numbers.
 */

import type { ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { MIN_CONTRIBUTION_MICRO } from "./money.js";

export class ContributionError extends Error {
    constructor(
        message: string,
        readonly statusCode: 400 | 404 | 409 | 422 = 422
    ) {
        super(message);
        this.name = "ContributionError";
    }
}

function ownerBalance(balances: readonly TokenBalance[] | null | undefined, mint: string, owner: string): bigint {
    let total = 0n;
    for (const b of balances ?? []) {
        if (b.mint === mint && b.owner === owner) total += BigInt(b.uiTokenAmount.amount);
    }
    return total;
}

/**
 * Measure a USDC transfer from [contributor] to [beneficiary] in a parsed
 * transaction. Pure — no I/O — so it is unit-testable against fixtures.
 * Returns the credited micro-USDC amount or throws [ContributionError].
 */
export function measureContribution(
    tx: ParsedTransactionWithMeta | null,
    params: {
        usdcMint: string;
        contributor: string;
        beneficiary: string;
        notBeforeUnixSeconds: number;
    }
): bigint {
    const { usdcMint, contributor, beneficiary, notBeforeUnixSeconds } = params;

    if (!tx) throw new ContributionError("Transaction not found or not yet confirmed", 404);
    if (!tx.meta) throw new ContributionError("Transaction has no metadata");
    if (tx.meta.err) throw new ContributionError("Transaction failed on-chain");
    if (contributor === beneficiary) throw new ContributionError("You can't fund your own dream", 400);

    const keys = tx.transaction.message.accountKeys;
    const signed = keys.some((k) => k.signer && k.pubkey.toBase58() === contributor);
    if (!signed) throw new ContributionError("Transaction was not signed by your wallet", 400);
    // If the owner co-signed, they could hand value straight back in the same
    // transaction (SOL or any token) — that's not support, it's a wash.
    if (keys.some((k) => k.signer && k.pubkey.toBase58() === beneficiary)) {
        throw new ContributionError("Contributions can't be co-signed by the dream owner", 400);
    }

    // Allow 2 minutes of clock skew between our DB clock and the cluster.
    if (tx.blockTime == null || tx.blockTime < notBeforeUnixSeconds - 120) {
        throw new ContributionError("Transaction predates this dream", 400);
    }

    const { preTokenBalances, postTokenBalances } = tx.meta;

    // The supporter must not receive any token back in the same transaction.
    const mints = new Set([...(preTokenBalances ?? []), ...(postTokenBalances ?? [])].map((b) => b.mint));
    for (const mint of mints) {
        if (ownerBalance(postTokenBalances, mint, contributor) > ownerBalance(preTokenBalances, mint, contributor)) {
            throw new ContributionError("Transaction sends tokens back to the supporter", 400);
        }
    }
    const received =
        ownerBalance(postTokenBalances, usdcMint, beneficiary) -
        ownerBalance(preTokenBalances, usdcMint, beneficiary);
    const sent =
        ownerBalance(preTokenBalances, usdcMint, contributor) -
        ownerBalance(postTokenBalances, usdcMint, contributor);

    // Credit only what provably moved from the supporter to the owner.
    const amount = received < sent ? received : sent;
    if (amount < MIN_CONTRIBUTION_MICRO) {
        throw new ContributionError("No USDC transfer to the dream owner found in this transaction");
    }
    return amount;
}
