/**
 * update-signer-policy.ts — one-off maintenance script that writes the
 * Phoenix-only ALLOW rule into the server signer's Privy policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * The copy engine signs mirrors with `walletApi.solana.signAndSendTransaction`
 * using the server authorization key. Privy gates that key with a policy
 * (`PRIVY_PHOENIX_POLICY_ID`). A policy with NO rules defaults to DENY, so every
 * mirror fails with "RPC request denied due to policy violation" even though the
 * order itself is built correctly.
 *
 * The Privy Dashboard cannot edit this policy because it is owned by an external
 * authorization key ("Updating this policy requires authorization from signers
 * external to the Privy Dashboard. Please use the Privy API to update this
 * policy."). This script IS that Privy API call — it authorizes the update with
 * the server's `PRIVY_AUTHORIZATION_KEY`, which is a member of the policy owner
 * quorum.
 *
 * WHAT IT WRITES
 * --------------
 * A single ALLOW rule for the `signAndSendTransaction` method whose only
 * condition is that every instruction's `programId` is in an allowlist. The
 * allowlist is intentionally tight — the Phoenix perps program (where enhanced
 * isolated market orders compile to) plus the Compute Budget program (fee/CU
 * hints, cannot move funds). The signer therefore can ONLY place Phoenix orders;
 * it can never transfer SOL or tokens out of the user's wallet.
 *
 * USAGE
 * -----
 *   pnpm policy:update            # apply the rule (idempotent)
 *   pnpm policy:update -- --dry   # print the current policy + planned rule only
 *
 * Required env: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY,
 * PRIVY_PHOENIX_POLICY_ID. Optional: PHOENIX_PROGRAM_IDS (comma-separated) to
 * override the default allowlist.
 */

import { PrivyClient } from "@privy-io/server-auth";
import config, { phoenixProgramIds } from "../src/config.js";

// Verified from live order instructions: the enhanced isolated market order
// endpoint compiles every instruction onto this single Phoenix perps program.
const PHOENIX_PERPS_PROGRAM = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const RULE_NAME = "Allow Phoenix perps (signAndSendTransaction)";  // <50 chars

function buildAllowlist(): string[] {
    const base =
        phoenixProgramIds.length > 0
            ? phoenixProgramIds
            : [PHOENIX_PERPS_PROGRAM];
    // Compute Budget cannot move funds; always allow it so CU/fee hints don't
    // trip the policy.
    const set = new Set([...base, COMPUTE_BUDGET_PROGRAM]);
    return [...set];
}

async function main(): Promise<void> {
    const dryRun = process.argv.includes("--dry");

    if (!config.PRIVY_APP_ID || !config.PRIVY_APP_SECRET) {
        throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET must be set");
    }
    if (!config.PRIVY_AUTHORIZATION_KEY) {
        throw new Error(
            "PRIVY_AUTHORIZATION_KEY must be set — it authorizes the policy update"
        );
    }
    if (!config.PRIVY_PHOENIX_POLICY_ID) {
        throw new Error("PRIVY_PHOENIX_POLICY_ID must be set");
    }

    const client = new PrivyClient(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET, {
        walletApi: {
            authorizationPrivateKey: config.PRIVY_AUTHORIZATION_KEY,
        },
    });

    const policyId = config.PRIVY_PHOENIX_POLICY_ID;
    const allowlist = buildAllowlist();

    console.log(`\nPolicy:    ${policyId}`);
    console.log(`Allowlist: ${allowlist.join(", ")}\n`);

    const current = await client.walletApi.getPolicy({ id: policyId });
    console.log(
        `Current rules (${current.rules?.length ?? 0}):`,
        JSON.stringify(current.rules ?? [], null, 2)
    );

    // Idempotency: skip if an ALLOW rule for signAndSendTransaction already
    // covers the full allowlist.
    const alreadyApplied = (current.rules ?? []).some(
        (rule) =>
            rule.action === "ALLOW" &&
            rule.method === "signAndSendTransaction" &&
            rule.conditions.some(
                (cond) =>
                    (cond as { fieldSource?: string }).fieldSource ===
                    "solana_program_instruction" &&
                    Array.isArray((cond as { value?: unknown }).value) &&
                    allowlist.every((p) =>
                        ((cond as { value: string[] }).value).includes(p)
                    )
            )
    );

    if (alreadyApplied) {
        console.log("\n✅ Policy already allows the Phoenix program — nothing to do.");
        return;
    }

    if (dryRun) {
        console.log("\n[dry run] Would add rule:");
        console.log(
            JSON.stringify(
                {
                    policyId,
                    name: RULE_NAME,
                    action: "ALLOW",
                    method: "signAndSendTransaction",
                    conditions: [
                        {
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            field_source: "solana_program_instruction",
                            field: "programId",
                            operator: "in",
                            value: allowlist,
                        } as any,
                    ],
                },
                null,
                2
            )
        );
        return;
    }

    const rule = await client.walletApi.addRuleToPolicy({
        policyId,
        name: RULE_NAME,
        action: "ALLOW",
        method: "signAndSendTransaction",
        conditions: [
            {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                field_source: "solana_program_instruction",
                field: "programId",
                operator: "in",
                value: allowlist,
            } as any,
        ],
    });

    console.log("\n✅ Rule added:");
    console.log(JSON.stringify(rule, null, 2));
}

main().catch((err) => {
    console.error("\n❌ Failed to update policy:", err);
    process.exit(1);
});
