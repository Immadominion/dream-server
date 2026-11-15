/**
 * Regenerates dream/test/fixtures/dream_txs.json — real server-built
 * transactions (launch, buy, sell, claim) from the Meteora DBC program on a
 * local validator. The app's tests use them to prove:
 *   - Dart signing is byte-identical to web3.js (launch: server mint
 *     signature + empty owner slot);
 *   - the client-side transaction guard accepts exactly these shapes and
 *     rejects tampered variants.
 * Requires a local validator with DBC cloned (see dbc-localnet-e2e.ts).
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 DREAM_DBC_CONFIG=<config> \
 *     npx tsx scripts/make-signer-fixture.ts ../dream/test/fixtures/dream_txs.json
 */

import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import { buildClaimTx, buildLaunchTx, buildSwapTx, connection } from "../src/dreams/coin.js";

const conn = connection();

function signLikeApp(b64: string, kp: Keypair): Transaction {
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.addSignature(kp.publicKey, Buffer.from(nacl.sign.detached(tx.serializeMessage(), kp.secretKey)));
    if (!tx.verifySignatures()) throw new Error("fixture signatures invalid");
    return tx;
}

async function send(b64: string, kp: Keypair): Promise<void> {
    const sig = await conn.sendRawTransaction(signLikeApp(b64, kp).serialize());
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
}

async function fund(kp: Keypair): Promise<void> {
    const sig = await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
}

async function main(): Promise<void> {
    const out = process.argv[2];
    if (!out) throw new Error("usage: make-signer-fixture.ts <out.json>");

    // Deterministic test-only keys (never funded on any real cluster).
    const ownerSeed = new Uint8Array(32).fill(7);
    const owner = Keypair.fromSeed(ownerSeed);
    const buyer = Keypair.fromSeed(new Uint8Array(32).fill(9));
    await Promise.all([fund(owner), fund(buyer)]);

    const launch = await buildLaunchTx({ owner: owner.publicKey.toBase58(), name: "Fixture Dream", symbol: "FIX" });
    const launchSigned = signLikeApp(launch.transaction, owner).serialize().toString("base64");
    await send(launch.transaction, owner);

    const buyAmount = BigInt(LAMPORTS_PER_SOL);
    const buy = await buildSwapTx({ pool: launch.pool, owner: buyer.publicKey.toBase58(), side: "buy", amountIn: buyAmount, slippageBps: 100 });
    await send(buy.transaction, buyer);

    const held = await conn.getParsedTokenAccountsByOwner(buyer.publicKey, { mint: new PublicKey(launch.mint) });
    const balance = BigInt(held.value[0]!.account.data.parsed.info.tokenAmount.amount as string);
    const sellAmount = balance / 2n;
    const sell = await buildSwapTx({ pool: launch.pool, owner: buyer.publicKey.toBase58(), side: "sell", amountIn: sellAmount, slippageBps: 100 });
    const claim = await buildClaimTx({ pool: launch.pool, owner: owner.publicKey.toBase58() });

    const fixture = {
        ownerSeedHex: Buffer.from(ownerSeed).toString("hex"),
        owner: owner.publicKey.toBase58(),
        buyer: buyer.publicKey.toBase58(),
        mint: launch.mint,
        pool: launch.pool,
        launch: { unsigned: launch.transaction, signed: launchSigned },
        buy: { tx: buy.transaction, amountIn: buyAmount.toString(), minimumOut: buy.minimumOut },
        sell: { tx: sell.transaction, amountIn: sellAmount.toString(), minimumOut: sell.minimumOut },
        claim: { tx: claim.transaction },
    };
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${out}`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
