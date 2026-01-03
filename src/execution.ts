import { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    Keypair, 
    Transaction, 
    VersionedTransaction, 
    TransactionMessage,
    ComputeBudgetProgram
} from "@solana/web3.js";
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { BN } from "@coral-xyz/anchor";
import { 
    TOKEN_PROGRAM_ID, 
    getMint, 
    createCloseAccountInstruction, 
    getAssociatedTokenAddress, 
    NATIVE_MINT, 
    createSyncNativeInstruction, 
    createAssociatedTokenAccountIdempotentInstruction 
} from "@solana/spl-token";
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import bs58 from "bs58";
// DynamicBondingCurveProgram is used for types if needed, but we use dynamic import for the client to avoid issues
import { 
    DYNAMIC_BONDING_CURVE_PROGRAM_ID
} from "@meteora-ag/dynamic-bonding-curve-sdk";


// Standard Config (Index 0) found on mainnet
const STANDARD_CONFIG_ADDRESS = new PublicKey("8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF");

// Wrapped SOL Mint Address
const WSOL = "So11111111111111111111111111111111111111112";

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

// Keeping old function for compatibility but deprecated
export function getComputedPoolAddress(tokenAMint: string, tokenBMint: string): string {
    return ""; // Deprecated, use fetchMeteoraPoolAddress
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

/**
 * Prepares a VersionedTransaction ready for Jito Bundling
 */
export async function prepareJitoTransaction(
    connection: Connection,
    payerKeypair: Keypair,
    poolAddress: string,
    inputTokenMint: string,
    inputAmountLamports: number,
    tipLamports: number,
    tipAccount: PublicKey,
    slippagePercent: number = 1.0
): Promise<VersionedTransaction | null> {
    try {
        const swapResult = await createSwapTransaction(
            connection,
            payerKeypair.publicKey,
            poolAddress,
            inputTokenMint,
            inputAmountLamports,
            slippagePercent
        );

        if (!swapResult) return null;

        const { transaction: swapTx } = swapResult;

        const tipIx = SystemProgram.transfer({
            fromPubkey: payerKeypair.publicKey,
            toPubkey: tipAccount,
            lamports: tipLamports,
        });

        const latestBlockhash = await connection.getLatestBlockhash("confirmed");
        
        // Combine instructions
        const instructions = [...swapTx.instructions, tipIx];

        const messageV0 = new TransactionMessage({
            payerKey: payerKeypair.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions,
        }).compileToV0Message();
        
        const vTx = new VersionedTransaction(messageV0);
        vTx.sign([payerKeypair]);

        return vTx;
    } catch (e: any) {
        console.error("❌ Error preparing Jito transaction:", e.message);
        return null;
    }
}

/**
 * Executes a Jito Bundle Swap (Swap + Tip)
 */
export async function executeJitoSwap(
    searcherClient: SearcherClient,
    connection: Connection,
    payerKeypair: Keypair,
    poolAddress: string,
    inputTokenMint: string,
    inputAmountLamports: number,
    tipLamports: number,
    tipAccount: PublicKey,
    slippagePercent: number = 1.0
): Promise<string | null> {
    const vTx = await prepareJitoTransaction(
        connection,
        payerKeypair,
        poolAddress,
        inputTokenMint,
        inputAmountLamports,
        tipLamports,
        tipAccount,
        slippagePercent
    );

    if (!vTx) return null;

    try {
        const bundle = new Bundle([vTx], 5);
        const result = await searcherClient.sendBundle(bundle);
        
        // @ts-ignore
        if (result.value) {
            // Extract signature for confirmation
            const signature = bs58.encode(vTx.signatures[0]);
            console.log(`📝 Jito Tx Signature: ${signature}`);
             // @ts-ignore
            console.log(`✅ Bundle ID: ${result.value}`);
            return signature;
        } else {
             // @ts-ignore
            console.error("❌ Bundle Error:", result);
            return null;
        }

    } catch (e: any) {
        console.error("❌ Error sending Jito Bundle:", e.message);
        return null;
    }
}

// EXECUTE SWAP SPECIFICALLY FOR DBC POOLS (Using Official Meteora DBC SDK + Direct RPC)
export async function executeDBCSwap(
    connection: Connection,
    wallet: Keypair,
    poolAddress: string,
    tokenInMint: string, // WSOL for buying
    tokenOutMint: string, // Target token mint
    amountIn: number,
    slippagePct: number = 5,
    closeTokenAccount: boolean = false, // New param to reclaim rent on sell
    priorityFeeMicroLamports: number = 100000 // Priority fee in microLamports (default 100k)
): Promise<{ signature: string | null; error?: string }> {
    try {
        console.log(`🔄 Building DBC Swap Transaction...`);
        console.log(`   Pool: ${poolAddress}`);
        console.log(`   Input: ${tokenInMint} (${amountIn} lamports)`);
        console.log(`   Output: ${tokenOutMint}`);
        
        // Initialize DBC Client (Official SDK)
        const { DynamicBondingCurveClient } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
        const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
        
        // Determine swap direction: swapBaseForQuote
        // In DBC pools, typically: Base = New Token, Quote = WSOL
        // If we're buying (WSOL -> Token), we're swapping Quote for Base, so swapBaseForQuote = false
        const swapBaseForQuote = tokenInMint !== WSOL; // false when buying with SOL
        
        const BN = (await import('bn.js')).default;
        
        // Build Swap Params (following official example)
        const swapParam = {
            amountIn: new BN(amountIn),
            minimumAmountOut: new BN(0), // High slippage for sniper (we can calculate from quote if needed)
            swapBaseForQuote: swapBaseForQuote,
            owner: wallet.publicKey,
            pool: new PublicKey(poolAddress),
            referralTokenAccount: null
        };
        
        // Get Swap Transaction from SDK
        const swapTx = await dbcClient.pool.swap(swapParam);
        
        // PRE-SWAP: Automatic Wrap SOL -> WSOL if buying with WSOL mint but expecting to pay with SOL
        // PRE-SWAP: Automatic Wrap SOL -> WSOL
        // User reported duplicate instructions. The SDK seems to handle WSOL creation/wrapping automatically.
        if (tokenInMint === WSOL) {
             console.log("💰 Relying on SDK/DBC for WSOL Wrapping...");
        } else if (tokenOutMint === WSOL) {
             // SELL Logic: SDK handles output WSOL account creation usually.
             // We skip manual creation to avoid redundant instructions (SDK often adds Create + Transfer 0.01 SOL)
             console.log("💰 Relying on SDK/DBC for Output WSOL Account...");
        }

        // PRIORITY FEES: Critical for landing transactions during congestion
        // Add Compute Budget instructions at the START of the transaction
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFeeMicroLamports
        });
        const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
            units: 200000 // Reasonable limit for DEX swap
        });
        
        swapTx.instructions.unshift(priorityFeeIx, computeLimitIx);

        console.log(`✅ DBC Swap Transaction Built (${swapTx.instructions.length} instructions)`);
        
        // OPTIONAL: Close Token Account to reclaim rent (only for selling)
        if (closeTokenAccount && tokenInMint !== WSOL) {
             const tokenIn = new PublicKey(tokenInMint);
             
             // Dynamic Program ID Detection (to support Token 2022)
             const mintInfo = await connection.getAccountInfo(tokenIn);
             const programId = mintInfo?.owner || TOKEN_PROGRAM_ID;

             const ata = await getAssociatedTokenAddress(tokenIn, wallet.publicKey, false, programId);
             
             console.log(`♻️ Adding CloseAccount instruction for ${tokenInMint}...`);
             // console.log(`   Program ID: ${programId.toBase58()}`);
             
             const closeIx = createCloseAccountInstruction(
                 ata,
                 wallet.publicKey, // Destination for rent
                 wallet.publicKey, // Owner
                 [],
                 programId
             );
             swapTx.add(closeIx);
        }

        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        
        // Build VersionedTransaction from the instructions (no Jito tip needed for RPC)
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: swapTx.instructions,
        }).compileToV0Message();
        
        const vTx = new VersionedTransaction(messageV0);
        vTx.sign([wallet]);
        
        console.log(`📦 Sending transaction via RPC (${swapTx.instructions.length} instructions)...`);
        
        // Send directly via RPC (Jito doesn't work well with DBC transactions)
        try {
            const signature = await connection.sendTransaction(vTx, {
                skipPreflight: false, // Enable preflight to catch errors early
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });
            console.log(`✅ Transaction sent: ${signature}`);
            return { signature };
        } catch (rpcError: any) {
            console.error(`❌ RPC send failed: ${rpcError.message}`);
            let errorMsg = rpcError.message;
            if (rpcError.logs) {
                console.error("📝 Logs:", rpcError.logs);
                // Extract custom error hex or message if possible
                const logStr = JSON.stringify(rpcError.logs);
                 if (logStr.includes("Pool is completed") || logStr.includes("0x177d") || logStr.includes("6013")) {
                     errorMsg = "PoolIsCompleted";
                     console.error("⚠️ CAUSE: The bonding curve is completed. Trading is disabled on this pool (migrated to Raydium/Meteora DLMM).");
                 } else if (logStr.includes("6033") || logStr.includes("Swap amount is over a threshold")) {
                     errorMsg = "SwapAmountTooHigh (Threshold Exceeded)";
                     console.error("⚠️ POSSIBLE CAUSE: You are trying to sell more tokens than the pool allows (Liquidity or Bond limit).");
                 }
            }
            return { signature: null, error: errorMsg };
        }
        
    } catch (e: any) {
        console.error("❌ DBC Swap Error:", e.message);
        return { signature: null, error: e.message };
    }
}

/**
 * Executes a Jito Bundle Swap with automatic rotation between Block Engines
 * Retries with different engines if rate limiting occurs
 */
export async function executeJitoSwapWithRotation(
    jitoClients: Map<string, any>,
    connection: Connection,
    payerKeypair: Keypair,
    poolAddress: string,
    inputTokenMint: string,
    inputAmountLamports: number,
    tipLamports: number,
    tipAccount: PublicKey,
    slippagePercent: number = 1.0
): Promise<string | null> {
    const clientEntries = Array.from(jitoClients.entries());
    
    if (clientEntries.length === 0) {
        console.error("❌ No Jito clients available for rotation.");
        return null;
    }

    console.log(`🔄 Attempting bundle submission across ${clientEntries.length} Block Engines...`);

    for (let i = 0; i < clientEntries.length; i++) {
        const [url, client] = clientEntries[i];
        console.log(`   Trying Block Engine ${i + 1}/${clientEntries.length}: ${url.substring(0, 30)}...`);

        try {
            const signature = await executeJitoSwap(
                client,
                connection,
                payerKeypair,
                poolAddress,
                inputTokenMint,
                inputAmountLamports,
                tipLamports,
                tipAccount,
                slippagePercent
            );

            if (signature) {
                console.log(`✅ Bundle accepted by Block Engine ${i + 1}`);
                return signature;
            }
        } catch (error: any) {
            // Check if it's a rate limiting error (code 8)
            if (error?.code === 8 || error?.error?.code === 8 || 
                error?.message?.includes('rate limited') || 
                error?.message?.includes('Resource has been exhausted')) {
                console.log(`   ⚠️ Engine ${i + 1} rate limited, trying next...`);
                continue; // Try next engine
            } else {
                // Other errors (simulation failure, etc.) - log and try next
                console.log(`   ❌ Engine ${i + 1} error: ${error?.message || error}`);
                continue;
            }
        }
    }

    console.error("❌ All Block Engines failed or rejected the bundle.");
    return null;
}

/**
 * Executes a Burn and Close Account transaction to reclaim rent from rugged tokens.
 */
export async function executeBurnAndClose(
    connection: Connection,
    wallet: Keypair,
    tokenMint: string
): Promise<string | null> {
    try {
        console.log(`🔥 Preparing Burn & Close for ${tokenMint}...`);
        const mintPubkey = new PublicKey(tokenMint);
        const ata = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
        
        // Check balance first
        const info = await connection.getTokenAccountBalance(ata);
        const amount = info.value.amount;

        const tx = new Transaction();

        // 1. Burn Tokens (if any)
        if (Number(amount) > 0) {
             const { createBurnInstruction } = await import("@solana/spl-token");
             const burnIx = createBurnInstruction(
                 ata,
                 mintPubkey,
                 wallet.publicKey,
                 BigInt(amount)
             );
             tx.add(burnIx);
        }

        // 2. Close Account
        const closeIx = createCloseAccountInstruction(
             ata,
             wallet.publicKey, // Destination for rent
             wallet.publicKey  // Owner
        );
        tx.add(closeIx);

        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        
        // Add priority fees just to be safe
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 });
        tx.instructions.unshift(priorityFeeIx);

        tx.sign(wallet);

        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log(`🔥 Burn & Close Transaction Sent: ${signature}`);
        return signature;

    } catch (e: any) {
        console.error("❌ Burn & Close Failed:", e.message);
        return null;
    }
}
