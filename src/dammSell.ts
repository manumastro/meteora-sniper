import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";

// WSOL Mint
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Execute a direct sell on Meteora DAMM v2 (CP-AMM) after migration.
 * This avoids Jupiter aggregator overhead and slippage.
 * 
 * @param connection Solana connection
 * @param wallet Wallet keypair
 * @param mint Token mint address (string)
 * @param amount Amount to sell (in lamports/smallest unit)
 * @returns Transaction signature or null on failure
 */
export async function executeDAMMv2Sell(
    connection: Connection,
    wallet: Keypair,
    mint: string,
    amount: number
): Promise<string | null> {
    try {
        console.log(`🔄 DAMM v2: Preparing Direct Sell for ${amount} tokens...`);
        
        // 1. Import the CP-AMM SDK dynamically
        const { CpAmm } = await import("@meteora-ag/cp-amm-sdk");
        const cpAmm = new CpAmm(connection);

        const tokenMint = new PublicKey(mint);

        // 2. Find the migrated pool by token mint (try tokenA first, then tokenB)
        console.log(`   🔍 Searching for DAMM v2 pool with token ${mint.slice(0, 8)}...`);
        
        let poolStates = await cpAmm.fetchPoolStatesByTokenAMint(tokenMint);
        
        // If not found as tokenA, search as tokenB (SOL is usually tokenA)
        if (poolStates.length === 0) {
            console.log("   🔍 Not found as tokenA, searching as tokenB...");
            // Fetch all pools and filter by tokenBMint (less efficient but necessary)
            const allPools = await cpAmm.getAllPools();
            poolStates = allPools.filter(p => p.account.tokenBMint.equals(tokenMint));
        }

        if (poolStates.length === 0) {
            console.log("   ❌ No DAMM v2 pool found for this token.");
            return null;
        }

        // Use the first pool found (most likely the migrated one)
        const { publicKey: poolAddress, account: poolState } = poolStates[0];
        console.log(`   ✅ Found DAMM v2 Pool: ${poolAddress.toBase58()}`);

        // 3. Determine input/output based on pool's tokenA/tokenB
        let inputTokenMint: PublicKey;
        let outputTokenMint: PublicKey;

        if (poolState.tokenAMint.equals(tokenMint)) {
            inputTokenMint = poolState.tokenAMint;
            outputTokenMint = poolState.tokenBMint;
        } else {
            inputTokenMint = poolState.tokenBMint;
            outputTokenMint = poolState.tokenAMint;
        }

        // 4. Get quote (for slippage protection)
        const currentSlot = await connection.getSlot();
        const blockTime = await connection.getBlockTime(currentSlot);

        // Get token decimals from pool state (assuming 9 for both as typical)
        const tokenADecimal = 9;
        const tokenBDecimal = 9;

        const quote = await cpAmm.getQuote({
            inAmount: new BN(amount),
            inputTokenMint: inputTokenMint,
            slippage: 1, // 1% slippage
            poolState,
            currentTime: blockTime || Math.floor(Date.now() / 1000),
            currentSlot,
            tokenADecimal,
            tokenBDecimal,
        });

        console.log(`   📊 Quote: ${amount} tokens -> ${quote.minSwapOutAmount.toString()} lamports (min)`);

        // 5. Build swap transaction
        const swapTx: Transaction = await cpAmm.swap({
            payer: wallet.publicKey,
            pool: poolAddress,
            inputTokenMint: inputTokenMint,
            outputTokenMint: outputTokenMint,
            amountIn: new BN(amount),
            minimumAmountOut: quote.minSwapOutAmount,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAMint: poolState.tokenAMint,
            tokenBMint: poolState.tokenBMint,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            referralTokenAccount: null, // Optional
        });

        // 6. Add close account instruction to reclaim rent
        const tokenAccount = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);
        swapTx.add(
            createCloseAccountInstruction(tokenAccount, wallet.publicKey, wallet.publicKey)
        );

        // 7. Sign and send transaction
        const { blockhash } = await connection.getLatestBlockhash();
        swapTx.recentBlockhash = blockhash;
        swapTx.feePayer = wallet.publicKey;
        swapTx.sign(wallet);

        console.log(`   📦 Sending DAMM v2 Swap...`);
        const signature = await connection.sendRawTransaction(swapTx.serialize(), {
            skipPreflight: true,
            maxRetries: 2
        });

        console.log(`   ✅ DAMM v2 Sell Sent: ${signature}`);
        return signature;

    } catch (e: any) {
        console.error(`   ❌ DAMM v2 Sell Failed: ${e.message}`);
        if (e.logs) {
            console.error("   📝 Logs:", e.logs.slice(-5));
        }
        return null;
    }
}
