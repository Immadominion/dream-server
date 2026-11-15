/**
 * One-time setup: create Dream's Meteora DBC partner config (+ partner
 * metadata) on-chain. Every dream coin is launched from this config.
 *
 * Usage:
 *   PARTNER_KEYPAIR_PATH=~/.config/solana/dream-partner.json \
 *   SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=... \
 *   npx tsx scripts/create-dream-dbc-config.ts [--execute]
 *
 * Without --execute it only builds and simulates the transactions (dry run).
 * The partner keypair becomes the fee claimer for Dream's share of fees and
 * must be kept offline/secure. Set the printed address as DREAM_DBC_CONFIG.
 *
 * Config accounts are immutable — to change economics, create a new config
 * and point DREAM_DBC_CONFIG at it (existing coins keep their old config).
 */

import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildDreamCurve, DEFAULT_CURVE_OPTIONS } from "../src/dreams/curve.js";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function loadKeypair(path: string): Keypair {
    const resolved = path.replace(/^~(?=\/)/, homedir());
    const secret = JSON.parse(readFileSync(resolved, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function simulateOrSend(
    connection: Connection,
    label: string,
    tx: Transaction,
    signers: Keypair[],
    execute: boolean
): Promise<void> {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);

    if (!execute) {
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
            console.error(`✗ ${label} simulation failed:`, sim.value.err, sim.value.logs?.slice(-8));
            process.exit(1);
        }
        console.log(`✓ ${label} simulates OK (${sim.value.unitsConsumed ?? "?"} CU)`);
        return;
    }
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    console.log(`✓ ${label}: ${sig}`);
}

async function main(): Promise<void> {
    const execute = process.argv.includes("--execute");
    const rpc = process.env.SOLANA_RPC_URL;
    const keypairPath = process.env.PARTNER_KEYPAIR_PATH;
    if (!rpc || !keypairPath) {
        console.error("SOLANA_RPC_URL and PARTNER_KEYPAIR_PATH are required");
        process.exit(1);
    }

    const connection = new Connection(rpc, "confirmed");
    const partner = loadKeypair(keypairPath);
    const client = new DynamicBondingCurveClient(connection, "confirmed");
    const configKeypair = Keypair.generate();

    const curveOptions = {
        initialMarketCapSol: Number(process.env.INITIAL_MCAP_SOL ?? DEFAULT_CURVE_OPTIONS.initialMarketCapSol),
        migrationMarketCapSol: Number(process.env.MIGRATION_MCAP_SOL ?? DEFAULT_CURVE_OPTIONS.migrationMarketCapSol),
    };
    const curve = buildDreamCurve(curveOptions);

    console.log(`Network:  ${rpc.replace(/api-key=[^&]+/, "api-key=***")}`);
    console.log(`Partner:  ${partner.publicKey.toBase58()}`);
    console.log(`Balance:  ${(await connection.getBalance(partner.publicKey)) / 1e9} SOL`);
    console.log(`Curve:    ${curveOptions.initialMarketCapSol} → ${curveOptions.migrationMarketCapSol} SOL mcap`);
    console.log(`Mode:     ${execute ? "EXECUTE" : "dry run (pass --execute to send)"}\n`);

    const createConfigTx = await client.partner.createConfig({
        ...curve,
        config: configKeypair.publicKey,
        feeClaimer: partner.publicKey,
        leftoverReceiver: partner.publicKey,
        quoteMint: WSOL_MINT,
        payer: partner.publicKey,
    });
    await simulateOrSend(connection, "createConfig", createConfigTx, [partner, configKeypair], execute);

    // Partner metadata lets explorers/aggregators attribute coins to Dream.
    // It is keyed by the partner wallet, so it only needs creating once.
    const existingMeta = await client.state.getPartnerMetadata(partner.publicKey);
    if (!existingMeta) {
        const metaTx = await client.partner.createPartnerMetadata({
            name: "Dream",
            website: "https://trydream.fun",
            logo: "https://trydream.fun/logo.png",
            feeClaimer: partner.publicKey,
            payer: partner.publicKey,
        });
        await simulateOrSend(connection, "createPartnerMetadata", metaTx, [partner], execute);
    }

    if (execute) {
        console.log(`\nDREAM_DBC_CONFIG=${configKeypair.publicKey.toBase58()}`);
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
