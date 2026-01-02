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


// Configuration from User Request & Analysis
const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"; 
const WSOL = config.wsol_pc_mint;

// Blacklist: Creators to avoid (e.g., "Bags: Token Authority")
const BLACKLISTED_CREATORS = [
    "BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv", // Bags: Token Authority
    // Add more addresses here as needed
];

// Investment settings (Hardcoded based on typical sniper needs or config)
const TRADE_AMOUNT_SOL = 0.01; 
const TIP_AMOUNT_SOL = config.jito.tip_buy_sol;

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
    console.log(`Amount: ${TRADE_AMOUNT_SOL} SOL`);

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
        // Retry Loop for RPC Latency (Identical to meteoraSniper.ts)
        let tx: any = null;
        for (let i = 0; i < 5; i++) {
            tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
            });

            if (tx && tx.meta) {
                break; // Found it!
            }

            console.log(`   Attempt ${i + 1} failed (Tx/Meta missing). Retrying in 1s...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!tx || !tx.meta) {
             console.log("❌ Transaction not found after retries. Skipping.");
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

        console.log(`🚀 Sending Buy Bundle for ${targetMint} on Pool ${poolAddress}...`);

        const { signature: swapSignature, error: buyError } = await executeDBCSwap(
            connection,
            walletKeypair,
            poolAddress,
            WSOL,
            targetMint, // Output token
            Math.floor(TRADE_AMOUNT_SOL * 1e9),
            50.0 // Max slippage for snipes
        );

        if (swapSignature) {
            console.log(`✅ SWAP SENT: https://solscan.io/tx/${swapSignature}`);
            
            // Confirm the Buy Transaction
            // Confirm the Buy Transaction (Fast Race: Signature vs Balance)
            console.log("⏳ Waiting for Buy Confirmation...");
            let buyConfirmed = false;
            const confirmStartTime = Date.now();
            
            while (Date.now() - confirmStartTime < 30000) { // 30s Max Wait
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

// Scheduled Auto-Sell (Blind) - Identical to meteoraSniper.ts
function scheduleAutoSell(mint: string, poolAddress: string, connection: Connection) {
    const delay = config.sell.auto_sell_delay_ms;
    console.log(`⏱️ Auto-Sell scheduled for ${mint} in ${delay / 1000}s...`);

    setTimeout(async () => {
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
                const MAX_SELL_ATTEMPTS = 5;
                
                for (let attempt = 1; attempt <= MAX_SELL_ATTEMPTS; attempt++) {
                    console.log(`📤 Sell Attempt ${attempt}/${MAX_SELL_ATTEMPTS}...`);
                    
                    const { signature, error } = await SellService.executeSell(
                        connection,
                        walletKeypair,
                        mint,
                        parseInt(balance),
                        poolAddress
                    );
                    
                    // Specific Error Checks
                    if (error === "PoolIsCompleted") {
                         console.log("🛑 POOL COMPLETED! Token has migrated/graduated.");
                         console.log("   🚀 Attempting Emergency Exit via Jupiter (Jito)...");
                         
                         // Fallback to Jupiter Sell
                         // HARDCODED TIP ACCOUNT TO PREVENT "Non-base58" ERRORS
                         const tipAccount = "96gYZGLnJFVFtHgZEUMu41FXu5N7QJ9kgD7rpq2LqR53"; 
                         
                         console.log(`   💡 Using Tip Account: ${tipAccount}`);

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
                             console.log(`✅ Jupiter Emergency Sell Sent: ${jupSignature}`);
                             console.log(`⏳ Verifying Jupiter confirmation...`);
                             const jupConfirmed = await confirmTransactionInclusion(connection, jupSignature, 60);
                             if (jupConfirmed) {
                                  console.log(`✅ Jupiter Sell Confirmed! Saved from graduation.`);
                                  sellConfirmed = true; 
                                  break;
                             } else {
                                  console.log("❌ Jupiter Sell Timed Out.");
                                  // Don't break immediately, maybe retry handled by manual logic? 
                                  // Actually, for graduation we should probably stop after one good try or manual intervention.
                                  // Unlocking to be safe.
                                  sellConfirmed = true; 
                                  break;
                             }
                         } else {
                             console.log("❌ Jupiter Sell Failed (No Route/Jito Error).");
                             console.log("   📉 Attempting Auto-Burn to reclaim rent...");
                             
                             const burnSig = await executeBurnAndClose(connection, walletKeypair, mint);
                             if (burnSig) {
                                 console.log(`✅ Auto-Burn Successful: https://solscan.io/tx/${burnSig}`);
                                 console.log("   Rent reclaimed. Position closed.");
                             } else {
                                console.log("❌ Auto-Burn Failed. Manual intervention required.");
                             }
                             
                             sellConfirmed = true; // Stop DBC retrying
                             break; 
                         }
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
                        // We attempt to burn tokens and close the account to reclaim 0.002 SOL rent.
                        if (attempt === MAX_SELL_ATTEMPTS) {
                            console.log("🔥 SELL FAILED REPEATEDLY (Likely Rugged). Initiating Auto-Burn protocol...");
                            console.log("   📉 Burning tokens to reclaim Rent (0.002 SOL)...");
                            
                            const burnSig = await executeBurnAndClose(connection, walletKeypair, mint);
                            if (burnSig) {
                                console.log(`✅ Auto-Burn Successful: https://solscan.io/tx/${burnSig}`);
                                console.log("   Rent reclaimed. Position closed.");
                                sellConfirmed = true; // Technically confirmed as "handled"
                                break;
                            } else {
                                console.log("❌ Auto-Burn Failed. Requires manual intervention.");
                            }
                        }

                        if (attempt < MAX_SELL_ATTEMPTS) {
                            console.log(`   Retrying in 5 seconds...`);
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                }
                
                if (!sellConfirmed) {
                    console.log(`❌ CRITICAL: Auto-Sell failed after ${MAX_SELL_ATTEMPTS} attempts. Manual intervention required.`);
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

    }, delay);
}

// Confirm Transaction Inclusion using Polling (Copied from meteoraSniper.ts)
async function confirmTransactionInclusion(connection: Connection, signature: string, maxRetries = 60): Promise<boolean> {
    console.log(`⏳ Confirming Transaction: ${signature}...`);
    for (let i = 0; i < maxRetries; i++) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
            console.log(`✅ Transaction Confirmed! (Status: ${status.value.confirmationStatus})`);
            return true;
        }
        await new Promise(r => setTimeout(r, 500)); // Wait 500ms (ultra-fast)
    }
    console.log("❌ Transaction Confirmation Timed Out (Bundle likely dropped).");
    return false;
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

// Start Sniper
startDBCSniper();
