import dotenv from "dotenv";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import bs58 from "bs58";
import { config } from "./config";
import { executeDBCSwap, executeBurnAndClose } from "./execution";
import { executeJupiterSell } from "./jupiterSwap";
import { SellService, SellStrategy } from "./services/sellService";
import { localRugCheck } from "./utils/localRugCheck";
import { getRugCheckConfirmed } from "./utils/rugCheck";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// 🎛️ CONFIGURATION - MODIFY THESE VALUES AS NEEDED
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // 💰 TRADING
    TRADE_AMOUNT_SOL: 0.001,              // Amount to buy per snipe
    
    // 🔒 ENTRY FILTERS
    MIN_POOL_LIQUIDITY_SOL: 50,          // Minimum liquidity to enter
    MAX_DEV_HOLDINGS_PERCENT: 5,         // Skip if dev holds more than this %
    MAX_BONDING_CURVE_PERCENT: 88,       // Skip if curve already above this %
    
    // 🎯 SELL TARGETS (Bonding Curve %)
    TARGET_DEFAULT: 90,                  // Normal target (curve < 90%)
    TARGET_MID_START: 92,                // Target when starting 90-92%
    TARGET_HIGH_START: 94,               // Target when starting > 92%
    
    // 📊 SELL THRESHOLDS
    THRESHOLD_MID_CURVE: 90,             // Above this → use TARGET_MID_START
    THRESHOLD_HIGH_CURVE: 92,            // Above this → use TARGET_HIGH_START
    
    // ⏱️ TIMING
    TIMEOUT_MS: 120000,                  // Max hold time (120 seconds)
    POLL_INTERVAL_MS: 600,               // Poll every 500ms
    
    // 🚨 EMERGENCY SELL TRIGGERS
    LIQUIDITY_SPIKE_SOL: 40,             // Sell if liquidity increases by this much
    STALE_CURVE_THRESHOLD_PERCENT: 0.1,    // Min curve movement required
    STALE_CURVE_TIMEOUT_MS: 5000,        // Time without movement before selling (5 seconds)
};


// ═══════════════════════════════════════════════════════════════════════════════

// Program IDs & Constants
const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"; 
const WSOL = config.wsol_pc_mint;
const TIP_AMOUNT_SOL = config.jito.tip_buy_sol;

// Blacklist: Creators to avoid
const BLACKLISTED_CREATORS = [
    "BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv", // Bags: Token Authority
];

// Jito Block Engines
const BLOCK_ENGINE_URLS = [
    "frankfurt.mainnet.block-engine.jito.wtf",
    "amsterdam.mainnet.block-engine.jito.wtf",
    "ny.mainnet.block-engine.jito.wtf",
    "tokyo.mainnet.block-engine.jito.wtf",
];

// Load Wallet
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY_B58) {
    console.error("❌ PRIVATE_KEY is missing in .env");
    process.exit(1);
}
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));

// Global State
let jitoClients = new Map<string, ReturnType<typeof searcherClient>>();
let tipAccounts: string[] = [];
let processedSignatures = new Set<string>();
let isPositionOpen = false;

// 1. Initialize Jito Clients (Identical to meteoraSniper.ts)
async function initJitoClients() {
    for (const url of BLOCK_ENGINE_URLS) {
        try {
            jitoClients.set(url, searcherClient(url, walletKeypair));
        } catch (e) {
            console.error(`Failed to init client for ${url}`);
        }
    }
    
    // Hardcoded Tip Accounts (Reliable list)
    tipAccounts = [
        "96gYZGLnJFVFtHgZEUMu41FXu5N7QJ9kgD7rpq2LqR53", 
        "Hf3aaSbbJqS9AIQdGOSb9eS1d9NSH6E74c3y13c4eFz", 
        "ADaUMid9yfUytqMBgopDjb6u78QmoNAok3sVV86X92", 
        "DfXygSm4jCyNCyb3qzK69cz12ueHD5yJiG1hR5tJQr9B",
        "ADuUkR4vqLUMWXxW9q6F628tkAIC6DDSjzenbsp9ts40",
        "DttWaMuVvTiduZRNgVJhs9B3ETFzhUVcX558ddn5wdbG", // Fixed corrupted address
        "3AVi9Tg9Uo68tJfuvoNrL2RTG8rrba1HpHWjGyKac",
        "ZwGNKrbK2eAg8NmGkMfeC5kmSiby4h3hF1a85Jtq19Q" 
    ];
}

// Prevent crash on background Jito auth errors
process.on('unhandledRejection', (reason, p) => {
    // @ts-ignore
    if (reason?.code === 7 || reason?.details?.includes('not authorized')) return;
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

async function startDBCSniper() {
    console.log("🔥 STARTING METEORA DBC SNIPER (Clone of Main Sniper) 🔥");
    console.log(`target program: ${DBC_PROGRAM_ID}`);
    console.log(`Wallet: ${walletKeypair.publicKey.toBase58()}`);
    console.log(`Amount: ${CONFIG.TRADE_AMOUNT_SOL} SOL`);

    await initJitoClients();

    const connection = new Connection(process.env.SVS_UNSTAKED_RPC || "https://api.mainnet-beta.solana.com", "confirmed");

    const sellService = new SellService();

    console.log("👀 Listening for 'initialize_virtual_pool' logs...");

    connection.onLogs(
        new PublicKey(DBC_PROGRAM_ID),
        async (logs) => {
            if (logs.err) return;
            const signature = logs.signature;

            if (processedSignatures.has(signature)) return;
            processedSignatures.add(signature);

            // Check specifically for the instruction we want
            const isInit = logs.logs.some(l => l.includes("initialize_virtual_pool") || l.includes("Instruction: InitializeVirtualPool"));
            
            if (isInit) {
                console.log(`✨ NEW DBC POOL DETECTED: ${signature}`);
                handleNewPool(connection, signature, sellService);
            }
        },
        "processed"
    );
}

async function handleNewPool(connection: Connection, signature: string, sellService: SellService) {
    if (isPositionOpen) return;
    isPositionOpen = true;
    let keepPositionOpen = false;

    console.log(`⏳ Processing Pool Creation: ${signature}`);
    try {
        // Retry Loop (2 attempts - fast)
        let tx: any = null;
        for (let i = 0; i < 2; i++) {
            tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
            });

            if (tx && tx.meta) break;
            if (i < 1) await new Promise(resolve => setTimeout(resolve, 100)); // 100ms between retries (fast)
        }

        if (!tx || !tx.meta) {
             console.log("❌ Transaction data not available after 2 attempts. Skipping.");
             return;
        }

        // Check if creator is blacklisted
        const feePayer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
        if (BLACKLISTED_CREATORS.includes(feePayer)) {
            console.log(`🛑 SKIPPING: Blacklisted creator detected: ${feePayer}`);
            return;
        }

        // Parse Anchor Log Data to get exact Pool Address and Token Mint
        const instructions = tx.transaction.message.instructions;
        const accountKeys = tx.transaction.message.accountKeys;

        console.log(`🔎 Analyzing ${instructions.length} instructions...`);

        // Find the instruction for DBC Program
        const dbcInstruction = instructions.find((ix: any) => ix.programId.toBase58() === DBC_PROGRAM_ID);
        
        if (!dbcInstruction) {
            console.log("❌ DBC Instruction key matching program ID not found in transaction.");
            return;
        }
        
        console.log("✅ Found DBC Instruction. Extracting accounts...");

        let targetMint = "";

        // Try to find the mint from the transaction accounts
        // In PartiallyDecodedInstruction, accounts are usually PublicKey[] (not indices)
        // Solscan Account #4 is index 3.
        if ('accounts' in dbcInstruction) {
             const ix = dbcInstruction as any;
             console.log(`   Instruction has ${ix.accounts.length} accounts.`);
             
             if (ix.accounts.length > 3) {
                // ix.accounts[3] IS the PublicKey of the Mint
                targetMint = ix.accounts[3].toString(); // .toString() handles both PublicKey obj or Base58 string
             }
        }

        // Fallback: PostTokenBalances
        if (!targetMint || targetMint === WSOL) {
             console.log("⚠️ extraction from accounts failed/ambiguous. Checking TokenBalances...");
             const postTokenBalances = tx.meta.postTokenBalances || [];
             const candidateToken = postTokenBalances.find((b: any) => b.mint !== WSOL && b.owner !== DBC_PROGRAM_ID);
             if (candidateToken) targetMint = candidateToken.mint;
        }

        if (!targetMint) {
            console.log("❌ Could not determine mint from TX");
            return;
        }

        console.log(`🎯 SNIPING MINT: ${targetMint}`);

        // DEV BUY CHECK - Check if creator bought tokens in the same TX
        // This catches cases where DEV creates pool + buys in one transaction
        console.log(`🔍 Checking for DEV buy in creation TX...`);
        try {
            const postBalances = tx.meta.postTokenBalances || [];
            
            // Known Meteora DBC Pool Authority
            const METEORA_POOL_AUTHORITY = "FhVo5GrrEq25XpPLsWsjUfRBLAi9oXCxxDJPoBZRjKYM";
            
            // Find token balances for our target mint (excluding pool/program accounts)
            const relevantBalances = postBalances.filter((b: any) => 
                b.mint === targetMint && 
                b.owner !== DBC_PROGRAM_ID &&
                b.owner !== METEORA_POOL_AUTHORITY &&
                b.owner !== "11111111111111111111111111111111" // Exclude system program
            );
            
            if (relevantBalances.length > 0) {
                // Get total supply from mint info
                const mintPubkey = new PublicKey(targetMint);
                const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
                const mintData = (mintInfo.value?.data as any)?.parsed?.info;
                const totalSupply = parseFloat(mintData?.supply || "1000000000000000000");
                
                // Check each holder's percentage
                for (const balance of relevantBalances) {
                    const amount = parseFloat(balance.uiTokenAmount?.amount || "0");
                    const percent = (amount / totalSupply) * 100;
                    
                    // Only flag if between 5% and 70% (pool usually has >80%)
                    // This catches DEV buys but not pool deposits
                    if (percent > CONFIG.MAX_DEV_HOLDINGS_PERCENT && percent < 70) {
                        console.log(`🛑 SKIPPING: Creator bought ${percent.toFixed(2)}% in creation TX (> ${CONFIG.MAX_DEV_HOLDINGS_PERCENT}% max)`);
                        console.log(`   Holder: ${balance.owner?.slice(0,4)}...${balance.owner?.slice(-4)}`);
                        console.log(`   🔗 https://gmgn.ai/sol/token/${targetMint}`);
                        return;
                    }
                    
                    if (percent > 0.1 && percent < 70) { // Only log significant non-pool holdings
                        console.log(`   Holder (${balance.owner?.slice(0,4)}...): ${percent.toFixed(2)}% of supply`);
                    }
                }
                console.log(`✅ DEV Buy Check Passed!`);
            } else {
                console.log(`   No DEV buy detected in creation TX. ✅`);
            }
        } catch (e: any) {
            console.log(`⚠️ DEV buy check error: ${e.message}. Proceeding with caution.`);
        }

        // SAFETY CHECK: RugCheck (Local or API)
        let isSafe = false;

        if (config.checks.use_local_checks) {
            // LOCAL RPC CHECKS (Fast)
            console.log(`🛡️ Performing Local Safety Check on ${targetMint}...`);
            const safety = await localRugCheck(connection, targetMint);
            if (!safety.isSafe) {
                console.log(`🛑 Local Safety Check Failed: ${safety.reason}`);
                console.log(`🛑 Blocked. Skipping.`);
                return;
            } else {
                console.log(`✅ Local Safety Check Passed! (Authorities Revoked)`);
                isSafe = true;
            }
        } else {
            // EXTERNAL RUGCHECK (Slow)
            const rugResult = await getRugCheckConfirmed(targetMint);
            if (!rugResult.isSafe) {
                console.log(`🛑 Blocked by RugCheck. Skipping.`);
                return;
            }
            isSafe = true;
        }

        if (!isSafe) {
            return;
        }

        // EXECUTE BUY using Direct RPC
        let poolAddress: string | null = null;
        
        // Type Guard to access 'accounts' property safely
        if (dbcInstruction && 'accounts' in dbcInstruction) {
             const ix = dbcInstruction as any; // Cast to access accounts
             if (ix.accounts && ix.accounts.length > 5) {
                 // Pool Address is Account #6 (Index 5)
                 poolAddress = ix.accounts[5].toString();
                 console.log(`✅ Extracted Pool from TX: ${poolAddress}`);
             }
        }
        
        // Validating Pool Address (Basic check)
        if (!poolAddress || poolAddress === "11111111111111111111111111111111") {
             console.log("⚠️ Could not extract VALID pool from TX (Found System Program or null). Skipping.");
             return;
        }

        // CHECK POOL LIQUIDITY (Skip if too low)
        console.log(`🔍 Checking Pool Liquidity...`);
        const liquidityCheck = await checkPoolLiquidity(connection, poolAddress);
        if (!liquidityCheck.isValid) {
            console.log(`🛑 SKIPPING: Pool liquidity too low (${liquidityCheck.liquiditySol.toFixed(2)} SOL < ${CONFIG.MIN_POOL_LIQUIDITY_SOL} SOL)`);
            return;
        }

        // CHECK BONDING CURVE (Skip if already too high - late entry)
        console.log(`🔍 Checking Bonding Curve...`);
        const currentCurve = await getBondingCurveProgress(connection, poolAddress);
        if (currentCurve > CONFIG.MAX_BONDING_CURVE_PERCENT) {
            console.log(`🛑 SKIPPING: Curve already at ${currentCurve.toFixed(1)}% (> ${CONFIG.MAX_BONDING_CURVE_PERCENT}% max entry)`);
            console.log(`   🔗 https://gmgn.ai/sol/token/${targetMint}`);
            return;
        }
        console.log(`✅ Curve at ${currentCurve.toFixed(1)}% - Entry OK!`);

        console.log(`🚀 Sending Buy Bundle for ${targetMint} on Pool ${poolAddress}...`);

        const { signature: swapSignature, error: buyError } = await executeDBCSwap(
            connection,
            walletKeypair,
            poolAddress,
            WSOL,
            targetMint, // Output token
            Math.floor(CONFIG.TRADE_AMOUNT_SOL * 1e9),
            50.0 // Max slippage for snipes
        );

        if (swapSignature) {
            console.log(`✅ SWAP SENT: https://solscan.io/tx/${swapSignature}`);
            
            // Confirm the Buy Transaction
            // Confirm the Buy Transaction (Fast Race: Signature vs Balance)
            console.log("⏳ Waiting for Buy Confirmation...");
            let buyConfirmed = false;
            const confirmStartTime = Date.now();
            
            while (Date.now() - confirmStartTime < 10000) { // 10s Max Wait (faster release)
                // 1. Check Signature Status (Fastest check usually)
                const status = await connection.getSignatureStatus(swapSignature, { searchTransactionHistory: false });
                if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
                    console.log(`✅ Transaction Confirmed via RPC!`);
                    buyConfirmed = true;
                    break;
                }
                
                // 2. Check Token Balance (Fallback if RPC signature indexing is slow)
                const currentBalance = await checkBalance(connection, walletKeypair.publicKey, targetMint);
                if (currentBalance > 0) {
                     console.log(`✅ Tokens received! Balance: ${currentBalance}`);
                     buyConfirmed = true;
                     break;
                }
                
                await new Promise(r => setTimeout(r, 500)); // Check every 500ms
            }
            
            if (buyConfirmed) {
                console.log("✅ BUY CONFIRMED! Scheduling Auto-Sell...");
                scheduleAutoSell(targetMint, poolAddress, connection);
                keepPositionOpen = true;
            } else {
                console.log("❌ Transaction Confirmation Timed Out (Bundle likely dropped).");
                
                // Double Check if tokens actully arrived (False Negative)
                console.log("   🔎 Verifying if tokens arrived despite timeout...");
                let tokensFound = false;
                try {
                     const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: new PublicKey(targetMint) });
                     const uiBalance = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;
                     if (uiBalance > 0) {
                         console.log(`⚠️ TIMEOUT FALSE ALARM! Found ${uiBalance} tokens. Proceeding to Auto-Sell.`);
                         tokensFound = true;
                     }
                } catch (e) { console.log("   Could not verify balance."); }

                if (tokensFound) {
                    scheduleAutoSell(targetMint, poolAddress, connection);
                    keepPositionOpen = true;
                } else {
                    console.log("❌ BUY FAILED / DROPPED. Releasing lock.");
                    keepPositionOpen = false;
                }
            }
        }

    } catch (e: any) {
        console.error(`Error handling new pool ${signature}:`, e.message);
    } finally {
        if (!keepPositionOpen) {
            isPositionOpen = false;
        }
    }
}

// Scheduled Auto-Sell (Dynamic Target System)
function scheduleAutoSell(mint: string, poolAddress: string, connection: Connection) {
    
    let targetCurve = CONFIG.TARGET_DEFAULT;
    let firstCheck = true;
    let initialLiquiditySol = 0;
    let lastCurveProgress = 0;
    let lastCurveChangeTime = Date.now();

    console.log(`⏱️ Auto-Sell scheduled for ${mint}. Checking initial curve...`);

    const startTime = Date.now();
    const intervalId = setInterval(async () => {
        const elapsed = Date.now() - startTime;
        const timeLeft = Math.max(0, Math.ceil((CONFIG.TIMEOUT_MS - elapsed) / 1000));
        
        // 1. CHECK BONDING CURVE PROGRESS
        const progress = await getBondingCurveProgress(connection, poolAddress);
        
        // On first check, determine target based on starting position + record initial liquidity
        if (firstCheck && progress > 0) {
            firstCheck = false;
            lastCurveProgress = progress;
            lastCurveChangeTime = Date.now();
            
            // Record initial liquidity
            const liquidityCheck = await checkPoolLiquidity(connection, poolAddress);
            initialLiquiditySol = liquidityCheck.liquiditySol;
            
            if (progress >= CONFIG.THRESHOLD_HIGH_CURVE) {
                targetCurve = CONFIG.TARGET_HIGH_START;
                console.log(`🚀 Very high start (${progress.toFixed(1)}% >= ${CONFIG.THRESHOLD_HIGH_CURVE}%). Target: ${targetCurve}%`);
            } else if (progress >= CONFIG.THRESHOLD_MID_CURVE) {
                targetCurve = CONFIG.TARGET_MID_START;
                console.log(`⚡ High start (${progress.toFixed(1)}% >= ${CONFIG.THRESHOLD_MID_CURVE}%). Target: ${targetCurve}%`);
            } else {
                console.log(`📈 Normal start (${progress.toFixed(1)}%). Target: ${targetCurve}%`);
            }
            console.log(`💧 Initial Liquidity: ${initialLiquiditySol.toFixed(1)} SOL (spike trigger: +${CONFIG.LIQUIDITY_SPIKE_SOL} SOL)`);
        }
        
        // 1.5 CHECK LIQUIDITY SPIKE (Possible rug setup!)
        if (initialLiquiditySol > 0) {
            const currentLiquidity = await checkPoolLiquidity(connection, poolAddress);
            const liquidityIncrease = currentLiquidity.liquiditySol - initialLiquiditySol;
            
            if (liquidityIncrease >= CONFIG.LIQUIDITY_SPIKE_SOL) {
                console.log(`🚨 LIQUIDITY SPIKE DETECTED! +${liquidityIncrease.toFixed(1)} SOL (${initialLiquiditySol.toFixed(1)} → ${currentLiquidity.liquiditySol.toFixed(1)})`);
                console.log(`🛡️ EMERGENCY SELL - Possible rug incoming!`);
                clearInterval(intervalId);
                executeAutoSellTransaction(mint, poolAddress, connection);
                return;
            }
        }
        
        // 1.6 CHECK STALE CURVE (No upward movement = suspicious)
        if (progress > 0) {
            const curveChange = progress - lastCurveProgress; // Only positive movement counts
            if (curveChange >= CONFIG.STALE_CURVE_THRESHOLD_PERCENT) {
                lastCurveProgress = progress;
                lastCurveChangeTime = Date.now();
            } else {
                const timeSinceChange = Date.now() - lastCurveChangeTime;
                if (timeSinceChange >= CONFIG.STALE_CURVE_TIMEOUT_MS && !firstCheck) {
                    console.log(`⚠️ STALE CURVE! No upward movement for ${(timeSinceChange/1000).toFixed(1)}s. Selling to be safe.`);
                    clearInterval(intervalId);
                    executeAutoSellTransaction(mint, poolAddress, connection);
                    return;
                }
            }
        }
        
        // LOG STATUS (Every check)
        if (progress > 0) {
             console.log(`📊 Curve: ${progress.toFixed(1)}% | ⏱️ ${timeLeft}s remaining (Target: ${targetCurve}%)`);
        }

        // 2. CHECK TARGET REACHED
        if (progress >= targetCurve) {
             console.log(`🚀 Bonding Curve Hit ${progress.toFixed(2)}% (>= ${targetCurve}%)! EXECUTING PROFIT TAKE...`);
             clearInterval(intervalId);
             executeAutoSellTransaction(mint, poolAddress, connection);
             return;
        }

        // 3. CHECK TIMEOUT
        if (elapsed >= CONFIG.TIMEOUT_MS) {
             console.log(`⏰ Time's up (${CONFIG.TIMEOUT_MS/1000}s)! Curve stuck at ${progress.toFixed(1)}%. Selling now.`);
             clearInterval(intervalId); 
             executeAutoSellTransaction(mint, poolAddress, connection);
             return;
        }
        
    }, CONFIG.POLL_INTERVAL_MS);
}
// Extracted Sell Logic for re-use
async function executeAutoSellTransaction(mint: string, poolAddress: string, connection: Connection) {
    console.log(`⏰ Executing Auto-Sell for ${mint}...`);

    if (config.dry_run) {
        console.log(`🛑 DRY RUN: Simulated Auto-Sell Execution for ${mint}`);
        return;
    }

    try {
        // Retry fetching balance for up to 3 times (RPC Latency correction)
        let balance = "0";
        let uiBalance = 0;

        for (let i = 0; i < 10; i++) {
            if (i > 0) console.log(`   ⏳ Checking balance (Attempt ${i + 1}/10)...`);

            try {
                const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: new PublicKey(mint) });
                const accountData = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount;
                if (accountData && accountData.uiAmount > 0) {
                    balance = accountData.amount;
                    uiBalance = accountData.uiAmount;
                    break; // Found balance!
                }
            } catch (e) {
                // Ignore RPC errors during balance check (e.g. mint not found yet)
            }
            
            if (i < 9) await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
        }

            if (uiBalance > 0) {
                console.log(`🚀 Selling ${uiBalance} tokens...`);
                
                // Retry loop for sell (max 5 attempts)
                let sellConfirmed = false;
                // RETRY PHASE 1: STANDARD ATTEMPTS (Base Priority Fee)
                // ----------------------------------------------------
                const MAX_SELL_ATTEMPTS = 5;
                const BASE_PRIORITY_FEE = 100000; // ~0.00002 SOL (Standard)

                for (let attempt = 1; attempt <= MAX_SELL_ATTEMPTS; attempt++) {
                    console.log(`📤 Sell Attempt ${attempt}/${MAX_SELL_ATTEMPTS} (Standard Fee)...`);
                    
                    const { signature, error } = await SellService.executeSell(
                        connection,
                        walletKeypair,
                        mint,
                        parseInt(balance),
                        poolAddress,
                        BASE_PRIORITY_FEE
                    );
                    
                    // Specific Error Checks
                    if (error === "PoolIsCompleted") {
                         console.log("🛑 POOL COMPLETED! Token has migrated/graduated.");
                         console.log("   🚀 Attempting Direct DAMM v2 Sell...");

                         // Import the new DAMM v2 sell function
                         const { executeDAMMv2Sell } = await import("./dammSell");

                         // RETRY LOOP (5 Attempts for DAMM v2)
                         let sold = false;
                         for (let j = 0; j < 5; j++) {
                            console.log(`   🔄 DAMM v2 Attempt ${j+1}/5...`);
                            
                            const dammSignature = await executeDAMMv2Sell(
                                connection,
                                walletKeypair,
                                mint,
                                parseInt(balance)
                            );

                            if (dammSignature) {
                                console.log(`   ✅ DAMM v2 Tx Sent: ${dammSignature}`);
                                const confirmed = await confirmTransactionInclusion(connection, dammSignature, 20);
                                if (confirmed) {
                                    console.log("   ✅ DAMM v2 Sell Confirmed! Saved from graduation.");
                                    sold = true;
                                    break;
                                }
                            }
                            
                            // Wait before retry
                            await new Promise(r => setTimeout(r, 1000));
                         }

                         // FALLBACK to Jupiter if DAMM v2 failed
                         if (!sold) {
                             console.log("   ⚠️ DAMM v2 Failed. Falling back to Jupiter...");
                             const tipAccount = "96gYZGLnJFVFtHgZEUMu41FXu5N7QJ9kgD7rpq2LqR53";
                             
                             for (let j = 0; j < 10; j++) {
                                console.log(`   🪐 Jupiter Attempt ${j+1}/10...`);
                                
                                const jupSignature = await executeJupiterSell(
                                    connection,
                                    jitoClients,
                                    walletKeypair,
                                    mint,
                                    parseInt(balance), 
                                    Math.floor(TIP_AMOUNT_SOL * 1e9),
                                    tipAccount
                                );

                                if (jupSignature) {
                                    const confirmed = await confirmTransactionInclusion(connection, jupSignature, 20);
                                    if (confirmed) {
                                        console.log("   ✅ Jupiter Sell Confirmed!");
                                        sold = true;
                                        break;
                                    }
                                }
                                
                                await new Promise(r => setTimeout(r, 2000));
                             }
                         }

                         if (!sold) {
                             console.log("❌ All Sell Attempts Failed. Manual intervention required. NOT BURNING.");
                         }
                         
                         sellConfirmed = true; 
                         break;
                    }
                    
                    if (signature) {
                        console.log(`✅ Auto Sell Bundle Sent: ${signature}`);
                        
                        // Wait and verify confirmation
                        console.log(`⏳ Verifying sell confirmation...`);
                        const confirmed = await confirmTransactionInclusion(connection, signature);
                        
                        if (confirmed) {
                            console.log(`✅ Sell Confirmed on-chain!`);
                            sellConfirmed = true;
                            break; // Exit retry loop
                        } else {
                            console.log(`⚠️ Sell not confirmed (Attempt ${attempt}/${MAX_SELL_ATTEMPTS})`);
                            
                            // Check if balance is gon (Sell might have succeeded but RPC timed out)
                            console.log(`   🔎 Checking if tokens are gone...`);
                            const currentBalance = await checkBalance(connection, walletKeypair.publicKey, mint);
                            if (currentBalance === 0) {
                                console.log(`✅ Balance is 0. Sell presumed successful (RPC lag).`);
                                sellConfirmed = true;
                                break;
                            }

                            if (attempt < MAX_SELL_ATTEMPTS) {
                                console.log(`   Retrying in 1 second...`);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        }
                    } else {
                        console.log(`❌ Sell Bundle Failed (Tx Creation/Send Error)`);
                        
                        // Check if failure is due to 0 balance (Already sold)
                        const currentBalance = await checkBalance(connection, walletKeypair.publicKey, mint);
                        if (currentBalance === 0) {
                             console.log(`✅ Balance is 0. Sell presumed successful (Previous attempt worked).`);
                             sellConfirmed = true;
                             break;
                        }

                        // AUTO-BURN / RUG HANDLER
                        // If we are at the last attempt and still failing, it's likely a rug/illiquid pool.
                        if (attempt === MAX_SELL_ATTEMPTS) {
                            console.log("⚠️ Standard Sells Failed. Moving to High Priority Phase...");
                            // Don't set sellConfirmed = true here, so we enter Phase 2
                            break;
                        }

                        if (attempt < MAX_SELL_ATTEMPTS) {
                            console.log(`   Retrying in 5 seconds...`);
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                }
                
                // RETRY PHASE 2: HIGH PRIORITY RESCUE (Boosted Fee)
                // -------------------------------------------------
                if (!sellConfirmed) {
                     console.log("🚨 Initiating HIGH PRIORITY RESCUE MODE (5 Attempts)...");
                     const HIGH_PRIORITY_FEE = 1000000; // ~0.001 SOL (50x Standard)

                     for (let attempt = 1; attempt <= 5; attempt++) {
                        console.log(`🚨 Rescue Attempt ${attempt}/5 (High Priority: ${HIGH_PRIORITY_FEE/1000}k)...`);
                        
                        const { signature, error } = await SellService.executeSell(
                            connection,
                            walletKeypair,
                            mint,
                            parseInt(balance),
                            poolAddress,
                            HIGH_PRIORITY_FEE
                        );

                        // Check for Migration immediately
                         if (error === "PoolIsCompleted") {
                             console.log("🛑 POOL COMPLETED during Rescue Mode.");
                             console.log("   🚀 Attempting Direct DAMM v2 Sell (Rescue)...");
                             const { executeDAMMv2Sell } = await import("./dammSell");
                             const dammSignature = await executeDAMMv2Sell(connection, walletKeypair, mint, parseInt(balance));
                             if (dammSignature) {
                                 const confirmed = await confirmTransactionInclusion(connection, dammSignature, 20);
                                 if (confirmed) {
                                     console.log("   ✅ DAMM v2 Sell Confirmed (Rescue)!");
                                     sellConfirmed = true;
                                     break;
                                 }
                             }
                             // Fallback to Jupiter Race Mode handled inside DAMM log (if we added it there) or stop here.
                             // For now, if DAMM fails here, we break phase 2.
                             break;
                         }

                        if (signature) {
                            console.log(`   ✅ Sell Tx Sent: ${signature}`);
                            const confirmed = await confirmTransactionInclusion(connection, signature);
                            if (confirmed) {
                                console.log("   ✅ Sell Confirmed (Rescue)!");
                                sellConfirmed = true;
                                break;
                            } else {
                                console.log("   ❌ Rescue Confirmation Timed Out.");
                            }
                        } else {
                             console.log(`   ❌ Rescue Sell Failed: ${error}`);
                        }
                        
                        if (!sellConfirmed && attempt < 5) await new Promise(r => setTimeout(r, 1000));
                     }
                }

                if (!sellConfirmed) {
                    console.log(`❌ CRITICAL: Sell failed after ALL attempts (Standard + Rescue). Manual intervention required.`);
                } else {
                    console.log("✅ Sell completed successfully!");
                }
            } else {
                console.log("⚠️ No balance found to sell (Buy likely failed or RPC lag).");
            }
        } catch (e) {
            console.error("❌ Auto-Sell Error:", e);
        } finally {
            console.log("🔓 Position Closed. Resume scanning.");
            isPositionOpen = false;
        }
}

// Confirm Transaction Inclusion using Polling (Copied from meteoraSniper.ts)
async function confirmTransactionInclusion(connection: Connection, signature: string, maxRetries = 60): Promise<boolean> {
    console.log(`⏳ Confirming Transaction: ${signature}...`);
    for (let i = 0; i < maxRetries; i++) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
            if (status.value.err) {
                console.log(`❌ Transaction Confirmed but FAILED: ${JSON.stringify(status.value.err)}`);
                return false;
            }
            console.log(`✅ Transaction Confirmed! (Status: ${status.value.confirmationStatus})`);
            return true;
        }
        await new Promise(r => setTimeout(r, 500)); // Wait 500ms (ultra-fast)
    }
    console.log("❌ Transaction Confirmation Timed Out (Bundle likely dropped).");
    return false;
}

// Check Pool Liquidity Helper
async function checkPoolLiquidity(connection: Connection, poolAddress: string): Promise<{ isValid: boolean; liquiditySol: number }> {
    try {
        const { StateService } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
        
        const stateService = new StateService(connection, 'confirmed');
        const poolData = await stateService.getPool(poolAddress);
        
        // Get quote reserves (SOL/WSOL liquidity in the pool)
        // quoteReserve is a BN (BigNumber) object
        const quoteReserve = poolData.quoteReserve;
        const liquiditySol = Number(quoteReserve.toString()) / 1e9; // Convert lamports to SOL
        
        console.log(`💧 Pool Liquidity: ${liquiditySol.toFixed(2)} SOL ($${(liquiditySol * 130).toFixed(0)})`);
        
        if (liquiditySol < CONFIG.MIN_POOL_LIQUIDITY_SOL) {
            console.log(`🛑 LIQUIDITY TOO LOW! Required: ${CONFIG.MIN_POOL_LIQUIDITY_SOL} SOL, Found: ${liquiditySol.toFixed(2)} SOL`);
            return { isValid: false, liquiditySol };
        }
        
        console.log(`✅ Liquidity Check Passed!`);
        return { isValid: true, liquiditySol };
        
    } catch (e: any) {
        console.error(`❌ Failed to check pool liquidity: ${e.message}`);
        // If we can't check, we assume it's risky and skip
        return { isValid: false, liquiditySol: 0 };
    }
}

// Check Balance Helper
async function checkBalance(connection: Connection, walletPubkey: PublicKey, mint: string): Promise<number> {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: new PublicKey(mint) });
        return tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch {
        return 0;
    }
}

// Check Bonding Curve Progress
async function getBondingCurveProgress(connection: Connection, poolAddress: string): Promise<number> {
    try {
        const { StateService } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
        const stateService = new StateService(connection, 'confirmed');
        const poolData = await stateService.getPool(poolAddress);
        
        if (!poolData || !poolData.config) return 0;

        // Fetch config to get migration threshold
        const configData = await stateService.getPoolConfig(poolData.config);
        
        const quoteReserve = Number(poolData.quoteReserve.toString());
        const migrationThreshold = Number(configData.migrationQuoteThreshold.toString());
        
        if (migrationThreshold === 0) return 0;
        
        const progress = (quoteReserve / migrationThreshold) * 100;
        return progress;
        
    } catch (e: any) {
        // console.error(`⚠️ Failed to check curve progress: ${e.message}`); // Verbose
        return 0;
    }
}

// Start Sniper
startDBCSniper();
