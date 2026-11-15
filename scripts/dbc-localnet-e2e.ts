/**
 * End-to-end check of the dream-coin lifecycle against a local validator
 * running the real Meteora DBC program (cloned from mainnet):
 *
 *   solana-test-validator --reset \
 *     --url https://api.mainnet-beta.solana.com \
 *     --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
 *     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 PARTNER_KEYPAIR_PATH=./partner.json \
 *     npx tsx scripts/create-dream-dbc-config.ts --execute
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 DREAM_DBC_CONFIG=<printed> \
 *     npx tsx scripts/dbc-localnet-e2e.ts
 *
 * It exercises the exact server functions the API uses, and signs the way the
 * mobile app does: sign the serialized message bytes and splice the
 * signature in, leaving the server's mint signature intact.
 */

import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
    buildClaimTx,
    buildLaunchTx,
    buildSwapTx,
    connection,
    getCoinStats,
    invalidateCoinStats,
    verifyLaunchedPool,
} from "../src/dreams/coin.js";

if (!process.env.SOLANA_RPC_URL?.includes("127.0.0.1")) {
    console.error("Refusing to run: SOLANA_RPC_URL must point at a local validator");
    process.exit(1);
}

const conn = connection();

async function fund(kp: Keypair, sol: number): Promise<void> {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

/** Mirror of the app's signer: sign message bytes, splice signature, submit. */
async function signLikeTheAppAndSend(base64: string, signer: Keypair): Promise<string> {
    const tx = Transaction.from(Buffer.from(base64, "base64"));
    const signature = nacl.sign.detached(tx.serializeMessage(), signer.secretKey);
    tx.addSignature(signer.publicKey, Buffer.from(signature));
    if (!tx.verifySignatures()) throw new Error("signature set incomplete/invalid");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    const status = await conn.getSignatureStatus(sig);
    if (status.value?.err) throw new Error(`tx failed: ${JSON.stringify(status.value.err)}`);
    return sig;
}

async function tokenBalance(owner: PublicKey, mint: string): Promise<bigint> {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function main(): Promise<void> {
    const owner = Keypair.generate();
    const buyer = Keypair.generate();
    await Promise.all([fund(owner, 5), fund(buyer, 50)]);

    // 1. Owner launches the coin for their dream.
    const launch = await buildLaunchTx({ owner: owner.publicKey.toBase58(), name: "Ada's Tuition", symbol: "ADA" });
    const launchSig = await signLikeTheAppAndSend(launch.transaction, owner);
    const launchCost = (5 * LAMPORTS_PER_SOL - (await conn.getBalance(owner.publicKey))) / LAMPORTS_PER_SOL;
    console.log(`✓ launch ${launchSig.slice(0, 16)}… mint=${launch.mint} cost=${launchCost.toFixed(5)} SOL`);

    // 2. Server-side verification that the pool is ours and the owner is creator.
    await verifyLaunchedPool({ pool: launch.pool, mint: launch.mint, owner: owner.publicKey.toBase58() });
    console.log("✓ verifyLaunchedPool");

    // 3. A supporter buys 10 SOL of the coin (during the anti-sniper window).
    const buy = await buildSwapTx({
        pool: launch.pool,
        owner: buyer.publicKey.toBase58(),
        side: "buy",
        amountIn: BigInt(10 * LAMPORTS_PER_SOL),
        slippageBps: 500,
    });
    await signLikeTheAppAndSend(buy.transaction, buyer);
    const held = await tokenBalance(buyer.publicKey, launch.mint);
    console.log(`✓ buy  10 SOL → ${held} base units (min ${buy.minimumOut})`);

    // 4. They sell half back.
    const sell = await buildSwapTx({
        pool: launch.pool,
        owner: buyer.publicKey.toBase58(),
        side: "sell",
        amountIn: held / 2n,
        slippageBps: 500,
    });
    await signLikeTheAppAndSend(sell.transaction, buyer);
    console.log(`✓ sell ${held / 2n} base units → ≥${sell.minimumOut} lamports`);

    // 5. The owner has accrued creator fees in SOL.
    invalidateCoinStats(launch.pool);
    const stats = await getCoinStats(launch.pool);
    console.log(
        `✓ stats progress=${(stats.curveProgress * 100).toFixed(2)}% ownerUnclaimed=${Number(stats.ownerUnclaimedLamports) / LAMPORTS_PER_SOL} SOL`
    );
    if (stats.ownerUnclaimedLamports <= 0n) throw new Error("expected creator fees to accrue");

    // 6. Owner claims; their SOL balance should rise by ~the unclaimed amount.
    const before = await conn.getBalance(owner.publicKey);
    const claim = await buildClaimTx({ pool: launch.pool, owner: owner.publicKey.toBase58() });
    await signLikeTheAppAndSend(claim.transaction, owner);
    const gained = (await conn.getBalance(owner.publicKey)) - before;
    console.log(`✓ claim  owner +${gained / LAMPORTS_PER_SOL} SOL (net of tx fee)`);

    // 7. A stranger cannot claim the owner's fees.
    try {
        await buildClaimTx({ pool: launch.pool, owner: buyer.publicKey.toBase58() });
        throw new Error("stranger claim was allowed");
    } catch (err) {
        if (err instanceof Error && err.message === "stranger claim was allowed") throw err;
        console.log("✓ stranger claim rejected");
    }

    console.log("\nALL CHECKS PASSED");
}

main().catch((err: unknown) => {
    console.error("✗", err);
    process.exit(1);
});
