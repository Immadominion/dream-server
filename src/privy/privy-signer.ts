/**
 * PrivyServerSigner — signs + broadcasts Solana transactions on behalf of a
 * user's embedded wallet WITHOUT the user's device, using a Privy
 * authorization key.
 *
 * This is what makes copy trading work while the user's app is closed:
 *  1. The user (on-device) delegates signing to the server by adding the
 *     server's authorization key as an owner/signer on their embedded wallet.
 *  2. The server holds the matching authorization PRIVATE key (env var) and
 *     uses it as the `authorizationContext` for every wallet action.
 *  3. A Phoenix-only policy on the wallet constrains what the key can sign, so
 *     the server can only ever place Phoenix perp orders — never move funds.
 *
 * The actual sign+broadcast happens via Privy's wallet API
 * (`walletApi.solana.signAndSendTransaction`), which signs with the user's
 * embedded wallet and submits to the configured Solana cluster.
 */

import { PrivyClient, type SolanaCaip2ChainId } from "@privy-io/server-auth";
import type { VersionedTransaction } from "@solana/web3.js";
import config from "../config.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "privy-signer" });

export class PrivyServerSigner {
  private static instance: PrivyServerSigner | null = null;

  private readonly client: PrivyClient;
  private readonly authorizationKey: string;

  private constructor() {
    if (!config.PRIVY_APP_ID || !config.PRIVY_APP_SECRET) {
      log.warn("Privy app credentials are not set — server signing will fail");
    }
    this.authorizationKey = config.PRIVY_AUTHORIZATION_KEY;
    this.client = new PrivyClient(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET, {
      walletApi: {
        authorizationPrivateKey: this.authorizationKey,
      },
    });
  }

  static getInstance(): PrivyServerSigner {
    if (!PrivyServerSigner.instance) {
      PrivyServerSigner.instance = new PrivyServerSigner();
    }
    return PrivyServerSigner.instance;
  }

  /** True when the signer has the credentials required to execute trades. */
  get isConfigured(): boolean {
    return Boolean(
      config.PRIVY_APP_ID && config.PRIVY_APP_SECRET && this.authorizationKey
    );
  }

  /**
   * Sign and broadcast a Phoenix transaction with the user's embedded wallet.
   *
   * @param privyWalletId Privy wallet id of the follower's embedded wallet.
   * @param transaction   A fully-built (unsigned) VersionedTransaction.
   * @returns The broadcast transaction signature.
   */
  async signAndSendTransaction(
    privyWalletId: string,
    transaction: VersionedTransaction
  ): Promise<string> {
    if (!this.isConfigured) {
      throw new Error(
        "PrivyServerSigner is not configured (missing app id/secret/authorization key)"
      );
    }

    const result = await this.client.walletApi.solana.signAndSendTransaction({
      walletId: privyWalletId,
      caip2: config.SOLANA_CAIP2 as SolanaCaip2ChainId,
      transaction,
    });

    const signature = (result as { hash?: string; signature?: string; data?: { hash?: string } }).hash ??
      (result as { signature?: string }).signature ??
      (result as { data?: { hash?: string } }).data?.hash;
    if (!signature) {
      throw new Error("Privy did not return a transaction signature");
    }
    return signature;
  }
}

export const privySigner = PrivyServerSigner.getInstance();
export default privySigner;
