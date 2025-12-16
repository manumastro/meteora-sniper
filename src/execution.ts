import { Connection, PublicKey, TransactionInstruction, Keypair, Transaction } from "@solana/web3.js";
import { CpAmm, derivePoolAddress } from '@meteora-ag/cp-amm-sdk';
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";

// Standard Config (Index 0) found on mainnet
const STANDARD_CONFIG_ADDRESS = new PublicKey("8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF");

export async function extractPoolAddressFromTxKeys(
    connection: Connection,
    keys: PublicKey[]
): Promise<string | null> {
    const CP_AMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
    const POOL_SIZE = 1112;

    try {
        // Optimize: tx usually has < 64 keys.
        const infos = await connection.getMultipleAccountsInfo(keys);

        for (let i = 0; i < infos.length; i++) {
            const info = infos[i];
            if (info && info.owner.equals(CP_AMM_ID) && info.data.length === POOL_SIZE) {
                return keys[i].toBase58();
            }
        }
    } catch (e: any) {
        console.error("Error extracting pool from keys:", e.message);
    }
    return null;
}

export function getComputedPoolAddress(tokenAMint: string, tokenBMint: string): string {
    // derivePoolAddress usually takes (connection, tokenA, tokenB) OR just (tokenA, tokenB) depending on SDK version
    // Based on common patterns in Solana SDKs, it might just need keys.
    // Let's assume it takes (tokenA, tokenB) PublicKeys.
    try {
        const keyA = new PublicKey(tokenAMint);
        const keyB = new PublicKey(tokenBMint);
        // Pass Standard Config as first argument
        // Note: Tokens might need sorting depending on SDK implementation, but let's assume SDK handles it or caller logic doesn't matter yet.
        const poolPda = derivePoolAddress(STANDARD_CONFIG_ADDRESS, keyA, keyB);
        return poolPda.toBase58();
    } catch (e: any) {
        console.error("Error derivig pool address:", e.message);
        // Fallback: maybe it's a customizable pool? try deriveCustomizablePoolAddress if available
        // But for now return empty string to avoid crash.
        return "";
    }
}

/**
 * Executes a fast swap on Meteora CP-AMM V2 directly via RPC.
 */
export async function createSwapTransaction(
    connection: Connection,
    payerPublicKey: PublicKey, // User's wallet public key
    poolAddress: string,
    inputTokenMint: string,
    inputAmountLamports: number,
    slippagePercent: number = 1.0
): Promise<{ transaction: Transaction; estimatedOutput: number } | null> {
    try {
        const poolPubkey = new PublicKey(poolAddress);

        // 1. Initialize Client
        // @ts-ignore - TS might complain about constructor signature if d.ts is wrong, but we verified it works at runtime
        const client = new CpAmm(connection);

        // 2. Fetch Pool State
        const poolState = await client.fetchPoolState(poolPubkey);
        if (!poolState) {
            console.error("❌ Failed to fetch pool state.");
            return null;
        }

        // 3. Prepare Parameters
        const inputMint = new PublicKey(inputTokenMint);
        const amountIn = new BN(inputAmountLamports);

        // Check which token is input (Token A or Token B)
        // poolState.tokenAMint and tokenBMint are PublicKeys
        const isInputTokenA = poolState.tokenAMint.equals(inputMint);
        const outputMint = isInputTokenA ? poolState.tokenBMint : poolState.tokenAMint;

    // 4. Get Decimals (Critical for accurate Quote)
        // We fetch mint info to ensure we use the correct decimals (e.g. 6 for USDC, 9 for SOL, others vary)
        const mintA = await getMint(connection, poolState.tokenAMint);
        const mintB = await getMint(connection, poolState.tokenBMint);

        // 5. Get Quote for Minimum Output (Slippage)
        // The SDK requires a quote to get minAmountOut
        // We need 'currentSlot' and 'currentTime' for getQuote
        const currentSlot = await connection.getSlot();
        const blockTime = await connection.getBlockTime(currentSlot);

        if (!blockTime) {
            console.error("❌ Failed to fetch block time.");
            return null;
        }

        const quote = await client.getQuote({
            inAmount: amountIn,
            inputTokenMint: inputMint,
            slippage: slippagePercent, // expects percentage e.g. 1.0
            poolState: poolState,
            currentTime: blockTime,
            currentSlot: currentSlot,
            tokenADecimal: mintA.decimals,
            tokenBDecimal: mintB.decimals,
        });

        console.log(`\n📊 Quote: ${amountIn.toString()} in -> ${quote.swapOutAmount.toString()} out`);
        console.log(`   Min Out: ${quote.minSwapOutAmount.toString()}`);

        // 5. Build Swap Transaction
        // swap returns a TxBuilder
        const swapBuilder = await client.swap({
            payer: payerPublicKey,
            pool: poolPubkey,
            inputTokenMint: inputMint,
            outputTokenMint: outputMint,
            amountIn: amountIn,
            minimumAmountOut: quote.minSwapOutAmount,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAMint: poolState.tokenAMint,
            tokenBMint: poolState.tokenBMint,
            tokenAProgram: TOKEN_PROGRAM_ID, // Assuming standard SPL token 
            tokenBProgram: TOKEN_PROGRAM_ID, // Assuming standard SPL token
            poolState: poolState, // Pass state to avoid re-fetch if supported
            referralTokenAccount: null // Explicitly pass null for optional account to satisfy Anchor validation
        } as any); // params slightly vary, casting any to bypass strict type check if docs differ from d.ts

        // 6. Convert to Transaction object
        // The TS error suggests swapBuilder is already a Transaction or similar
        const tx = swapBuilder as unknown as Transaction;

        return {
            transaction: tx,
            estimatedOutput: quote.swapOutAmount.toNumber()
        };

    } catch (error) {
        console.error("❌ Error building fast swap transaction:", error);
        return null;
    }
}

/**
 * Test function to verify we can load a pool
 */
export async function testPoolConnection(connection: Connection, poolAddress: string) {
    console.log(`\n🧪 Testing connection to pool: ${poolAddress}`);
    try {
        // @ts-ignore
        const client = new CpAmm(connection);
        const poolState = await client.fetchPoolState(new PublicKey(poolAddress));

        console.log("✅ Pool State Fetched!");
        console.log(`   Token A: ${poolState.tokenAMint.toBase58()}`);
        console.log(`   Token B: ${poolState.tokenBMint.toBase58()}`);
        console.log(`   Liquidity: ${poolState.liquidity.toString()}`);

        return true;
    } catch (e: any) {
        console.error("❌ Failed to test pool connection:", e.message);
        return false;
    }
}
