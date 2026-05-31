/**
 * PhoenixOrderBuilder — requests order instructions from the Phoenix API and
 * compiles them into a Solana VersionedTransaction ready for signing.
 *
 * Server-side port of the Dream client's `PhoenixOrderService`, with one
 * simplification: instead of hand-serializing the legacy message, we build the
 * transaction with `@solana/web3.js` and hand it to Privy to sign + broadcast.
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import config from "../config.js";
import { logger } from "../logger.js";
import type {
  PhoenixEnhancedOrderResponse,
  PhoenixInstruction,
} from "./types.js";

const log = logger.child({ module: "phoenix-order-builder" });

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

export interface BuildMarketOrderParams {
  authority: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  transferAmountUsdc?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  slippageBps?: number;
}

export interface BuiltOrder {
  transaction: VersionedTransaction;
  estimatedLiquidationPrice?: number;
}

/** Strip the `-PERP` suffix the API does not expect. */
function toApiSymbol(symbol: string): string {
  return symbol.endsWith("-PERP") ? symbol.slice(0, -5) : symbol;
}

function buildTpSl(
  stopLoss?: number,
  takeProfit?: number
): Record<string, number> | undefined {
  if (stopLoss == null && takeProfit == null) return undefined;
  const tpSl: Record<string, number> = {};
  if (stopLoss != null) {
    tpSl.stopLossTriggerPrice = stopLoss;
    tpSl.stopLossExecutionPrice = stopLoss;
  }
  if (takeProfit != null) {
    tpSl.takeProfitTriggerPrice = takeProfit;
    tpSl.takeProfitExecutionPrice = takeProfit;
  }
  return tpSl;
}

/** Request enhanced market-order instructions from Phoenix. */
async function requestMarketOrderInstructions(
  params: BuildMarketOrderParams
): Promise<PhoenixEnhancedOrderResponse> {
  const slippageBps = params.slippageBps ?? 50;
  const body: Record<string, unknown> = {
    authority: params.authority,
    symbol: toApiSymbol(params.symbol),
    side: params.side,
    quantity: params.quantity,
  };
  if (params.transferAmountUsdc && params.transferAmountUsdc > 0) {
    body.transferAmount = params.transferAmountUsdc;
  }
  if (config.FLIGHT_BUILDER_AUTHORITY) {
    body.flightBuilderAuthority = config.FLIGHT_BUILDER_AUTHORITY;
  }
  if (slippageBps !== 50) body.slippageBps = slippageBps;
  const tpSl = buildTpSl(params.stopLossPrice, params.takeProfitPrice);
  if (tpSl) body.tpSl = tpSl;

  const res = await fetch(
    `${config.PHOENIX_API_URL}/v1/ix/place-isolated-market-order-enhanced`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Phoenix order build failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as PhoenixEnhancedOrderResponse;
  if (!json.instructions || json.instructions.length === 0) {
    throw new Error("Phoenix returned no instructions");
  }
  return json;
}

/** Compile Phoenix instructions into a signable VersionedTransaction. */
async function compileTransaction(
  instructions: PhoenixInstruction[],
  feePayer: string
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const web3Instructions = instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(ix.data),
      })
  );

  const message = new TransactionMessage({
    payerKey: new PublicKey(feePayer),
    recentBlockhash: blockhash,
    instructions: web3Instructions,
  }).compileToV0Message();

  return new VersionedTransaction(message);
}

/** Build a fully-formed (unsigned) market-order transaction. */
export async function buildMarketOrder(
  params: BuildMarketOrderParams
): Promise<BuiltOrder> {
  log.info(
    { side: params.side, qty: params.quantity, symbol: params.symbol },
    "building market order"
  );
  const resp = await requestMarketOrderInstructions(params);
  const transaction = await compileTransaction(resp.instructions, params.authority);
  return { transaction, estimatedLiquidationPrice: resp.estimatedLiquidationPrice };
}
