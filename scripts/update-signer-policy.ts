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
// endpoint compiles instructions onto the Phoenix perps program AND the
// Phoenix Flight builder-fee program (added whenever a flightBuilderAuthority
// is attached so the platform earns builder fees). BOTH must be allowlisted —
// the policy's `programId in [...]` condition requires EVERY instruction's
// program to be in the list, so a single missing program denies the whole tx.
const PHOENIX_PERPS_PROGRAM = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";
const PHOENIX_FLIGHT_PROGRAM = "F1ightu9cujFYo34k9CabifLrJT8qzfDVM2Q7BqhJn2W";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const RULE_NAME = "Allow Phoenix perps (signAndSendTransaction)";  // <50 chars

function buildAllowlist(): string[] {
    const base =
        phoenixProgramIds.length > 0
            ? phoenixProgramIds
            : [PHOENIX_PERPS_PROGRAM, PHOENIX_FLIGHT_PROGRAM];
    // Compute Budget cannot move funds; always allow it so CU/fee hints don't
    // trip the policy. The Flight builder-fee program is required because every
    // order attaches a builder authority — always include it.
    const set = new Set([...base, PHOENIX_FLIGHT_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
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

    // Locate the existing ALLOW rule for signAndSendTransaction (if any). We
    // UPDATE it in place rather than appending a second rule: each
    // `programId in [...]` condition requires EVERY instruction's program to be
    // in its own list, so a second rule with a different list would never match
    // and the request would still be denied.
    const existingRule = (current.rules ?? []).find(
        (rule) =>
            rule.action === "ALLOW" &&
            rule.method === "signAndSendTransaction"
    );

    const ruleCoversAllowlist =
        existingRule?.conditions.some(
            (cond) =>
                (cond as { fieldSource?: string }).fieldSource ===
                "solana_program_instruction" &&
                Array.isArray((cond as { value?: unknown }).value) &&
                allowlist.every((p) =>
                    ((cond as { value: string[] }).value).includes(p)
                )
        ) ?? false;

    if (existingRule && ruleCoversAllowlist) {
        console.log("\n✅ Policy already allows the full allowlist — nothing to do.");
        return;
    }

    const conditions = [
        {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            field_source: "solana_program_instruction",
            field: "programId",
            operator: "in",
            value: allowlist,
        } as any,
    ];

    if (dryRun) {
        const action = existingRule ? "update existing rule" : "add rule";
        console.log(`\n[dry run] Would ${action}:`);
        console.log(
            JSON.stringify(
                {
                    policyId,
                    ruleId: (existingRule as { id?: string } | undefined)?.id,
                    name: RULE_NAME,
                    action: "ALLOW",
                    method: "signAndSendTransaction",
                    conditions,
                },
                null,
                2
            )
        );
        return;
    }

    if (existingRule) {
        const ruleId = (existingRule as { id?: string }).id;
        if (!ruleId) {
            throw new Error("Existing rule has no id — cannot update it");
        }
        const rule = await client.walletApi.updateRuleInPolicy({
            policyId,
            ruleId,
            name: RULE_NAME,
            action: "ALLOW",
            method: "signAndSendTransaction",
            conditions,
        });
        console.log("\n✅ Rule updated:");
        console.log(JSON.stringify(rule, null, 2));
        return;
    }

    const rule = await client.walletApi.addRuleToPolicy({
        policyId,
        name: RULE_NAME,
        action: "ALLOW",
        method: "signAndSendTransaction",
        conditions,
    });

    console.log("\n✅ Rule added:");
    console.log(JSON.stringify(rule, null, 2));
}

main().catch((err) => {
    console.error("\n❌ Failed to update policy:", err);
    process.exit(1);
});
