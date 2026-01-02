import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export interface TokenSafetyResult {
    isSafe: boolean;
    reason?: string;
}

export async function localRugCheck(connection: Connection, mintAddress: string): Promise<TokenSafetyResult> {
    try {
        const mintPubkey = new PublicKey(mintAddress);

        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) {
            return { isSafe: false, reason: "Mint Account not found" };
        }

        // @ts-ignore
        const data = mintInfo.value.data.parsed.info;
        const mintAuthority = data.mintAuthority;
        const freezeAuthority = data.freezeAuthority;

        if (!config.checks.settings.allow_mint_authority && mintAuthority) {
            return { isSafe: false, reason: `Mint Authority not revoked (${mintAuthority})` };
        }
        if (!config.checks.settings.allow_freeze_authority && freezeAuthority) {
            return { isSafe: false, reason: `Freeze Authority not revoked (${freezeAuthority})` };
        }

        if (!config.checks.settings.allow_mutable) {
            try {
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("metadata"),
                        METADATA_PROGRAM_ID.toBuffer(),
                        mintPubkey.toBuffer(),
                    ],
                    METADATA_PROGRAM_ID
                );

                const metadataAccountInfo = await connection.getAccountInfo(metadataPDA);
                if (metadataAccountInfo) {
                    const isMutable = metadataAccountInfo.data[1] === 1;
                    
                    if (isMutable) {
                        return { isSafe: false, reason: "Metadata is mutable" };
                    }
                }
            } catch (e: any) {
                console.log(`⚠️ Metaplex metadata check skipped: ${e.message}`);
            }
        }

        try {
            const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
            const holders = largestAccounts.value;

            if (holders && holders.length > 0) {
                const supply = parseFloat(data.supply);
                if (!supply || supply === 0) {
                    // Log success with basic info
                    console.log(`\n📋 Safety Check Details:`);
                    console.log(`   Mint Authority: ${mintAuthority ? '❌ Present' : '✅ Revoked'}`);
                    console.log(`   Freeze Authority: ${freezeAuthority ? '❌ Present' : '✅ Revoked'}`);
                    console.log(`   Max Single Holder: N/A (No supply)`);
                    console.log(`   Status: ✅ PASSED\n`);
                    return { isSafe: true }; 
                }

                let maxSinglePercentage = 0;

                for (let i = 0; i < Math.min(holders.length, 10); i++) {
                    const holder = holders[i];
                    if (!holder.amount) continue;

                    const amount = parseFloat(holder.amount);
                    const pct = (amount / supply) * 100;

                    if (pct > maxSinglePercentage) maxSinglePercentage = pct;
                }

                const MAX_SINGLE_PCT = config.checks.settings.max_alowed_pct_topholders || 50; 
                
                if (maxSinglePercentage > MAX_SINGLE_PCT) {
                     return { isSafe: false, reason: `Single Holder owns ${maxSinglePercentage.toFixed(2)}% (Limit: ${MAX_SINGLE_PCT}%)` };
                }

                // Log detailed success info
                console.log(`\n📋 Safety Check Details:`);
                console.log(`   Mint Authority: ${mintAuthority ? '❌ Present' : '✅ Revoked'}`);
                console.log(`   Freeze Authority: ${freezeAuthority ? '❌ Present' : '✅ Revoked'}`);
                console.log(`   Max Single Holder: ${maxSinglePercentage.toFixed(2)}% (Limit: ${MAX_SINGLE_PCT}%)`);
                console.log(`   Status: ✅ PASSED\n`);
            }
        } catch (e: any) {
            if (e.message && e.message.includes("not a Token mint")) {
                // Token-2022 or NFT - skip holder check but still validate authorities
                console.log(`⚠️ Non-standard token (Token-2022/NFT). Skipping holder check.`);
                console.log(`   Authorities already validated: Mint=${mintAuthority ? '❌' : '✅'}, Freeze=${freezeAuthority ? '❌' : '✅'}`);
                // Don't block - authorities were already checked above
            } else {
                throw e;
            }
        }

        return { isSafe: true };

    } catch (e: any) {
        console.error(`❌ Local Safety Check Failed: ${e.message}`);
        return { isSafe: false, reason: "RPC Error during check" };
    }
}

// Helper function to log detailed safety check results
export function logSafetyCheckDetails(mintAddress: string, mintAuthority: string | null, freezeAuthority: string | null, maxSinglePct: number) {
    console.log(`\n📋 Safety Check Details for ${mintAddress.substring(0, 8)}...:`);
    console.log(`   Mint Authority: ${mintAuthority ? '❌ Present' : '✅ Revoked'}`);
    console.log(`   Freeze Authority: ${freezeAuthority ? '❌ Present' : '✅ Revoked'}`);
    console.log(`   Max Single Holder: ${maxSinglePct.toFixed(2)}% (Limit: ${config.checks.settings.max_alowed_pct_topholders}%)`);
    console.log(`   Status: ✅ PASSED\n`);
}
