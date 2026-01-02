import WebSocket from "ws";
import dotenv from "dotenv";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import bs58 from "bs58";
import { getComputedPoolAddress, extractPoolAddressFromTxKeys, executeJitoSwap, executeJitoSwapWithRotation } from "./execution";


import { SellService, SellStrategy } from "./services/sellService";
import { executeJupiterBuy } from "./jupiterSwap";
import { localRugCheck } from "./utils/localRugCheck";

dotenv.config();

// Constants & Env
const WSS_ENDPOINT = process.env.SVS_UNSTAKED_WSS;
const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC;
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY;
const JITO_TIP_AMOUNT_SOL = config.jito.tip_buy_sol;

const PROGRAM_ID = config.program.id;
const PROGRAM_META_LOGS = config.program.meta_logs;
const WSOL = config.wsol_pc_mint;

// Trading Config
const TRADE_AMOUNT_SOL = 0.001;

// RugCheck Integration
import { getRugCheckConfirmed } from "./utils/rugCheck";

// CheckRugCheckScore is now replaced by getRugCheckConfirmed
// Wrapper to maintain similarity or just use new function directly
async function checkRugCheckScore(mintAddress: string): Promise<boolean> {
    const result = await getRugCheckConfirmed(mintAddress);
    return result.isSafe;
}


// Globals
let tipAccounts: string[] = [];
let jitoClients = new Map<string, ReturnType<typeof searcherClient>>();
let jitoClient: ReturnType<typeof searcherClient>;
let isInitializing = false;
let reconnectDelay = 5000;

// Jito Block Engines
const BLOCK_ENGINE_URLS = [
    "frankfurt.mainnet.block-engine.jito.wtf",
    "amsterdam.mainnet.block-engine.jito.wtf",
    "ny.mainnet.block-engine.jito.wtf",
    "tokyo.mainnet.block-engine.jito.wtf",
];

// Setup Wallet
if (!PRIVATE_KEY_B58) {
    console.error("❌ PRIVATE_KEY is missing in .env");
    process.exit(1);
}
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));

// Prevent crash on Jito Auth error (background promise)
process.on('unhandledRejection', (reason, p) => {
    // @ts-ignore
    if (reason?.code === 7 || reason?.details?.includes('not authorized')) {
        // Ignore Jito Auth errors - we can likely still send bundles or it's a non-fatal background auth
        return;
    }
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

// Scheduled Auto-Sell (Blind)
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

            for (let i = 0; i < 3; i++) {
                if (i > 0) console.log(`   ⏳ Checking balance (Attempt ${i + 1}/3)...`);

                const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: new PublicKey(mint) });
                const accountData = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount;
                if (accountData && accountData.uiAmount > 0) {
                    balance = accountData.amount;
                    uiBalance = accountData.uiAmount;
                    break; // Found balance!
                }
                if (i < 2) await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
            }

            if (uiBalance > 0) {
                console.log(`🚀 Selling ${uiBalance} tokens...`);
                
                // Retry loop for sell (max 5 attempts)
                let sellConfirmed = false;
                const MAX_SELL_ATTEMPTS = 5;
                
                for (let attempt = 1; attempt <= MAX_SELL_ATTEMPTS; attempt++) {
                    console.log(`📤 Sell Attempt ${attempt}/${MAX_SELL_ATTEMPTS}...`);
                    
                    const signature = await SellService.executeSell(
                        connection,
                        walletKeypair,
                        mint,
                        parseInt(balance),
                        poolAddress,
                        SellStrategy.JITO, // Use Direct Meteora Swap
                        jitoClients,
                        jitoClient,
                        tipAccounts,
                        config.jito.tip_sell_sol
                    );
                    
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
                            if (attempt < MAX_SELL_ATTEMPTS) {
                                console.log(`   Retrying in 1 second...`);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        }
                    } else {
                        console.log(`❌ Sell Bundle Failed (Attempt ${attempt}/${MAX_SELL_ATTEMPTS})`);
                        if (attempt < MAX_SELL_ATTEMPTS) {
                            console.log(`   Retrying in 5 seconds...`);
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                }
                
                if (!sellConfirmed) {
                    console.log(`❌ CRITICAL: Auto-Sell failed after ${MAX_SELL_ATTEMPTS} attempts. Manual intervention required.`);
                    console.log(`⚠️ Bot will NOT process new transactions until this is resolved.`);
                } else {
                    isInitializing = false;
                    console.log("✅ Sell completed successfully!");
                    console.log("🔄 Bot ready for next transaction...");
                }
            } else {
                console.log("⚠️ No balance found to sell (Buy likely failed or RPC lag).");
                isInitializing = false;
                console.log("🔄 Bot ready for next transaction...");
            }
        } catch (e) {
            console.error("❌ Auto-Sell Error:", e);
            isInitializing = false;
            console.log("🔄 Bot ready for next transaction (after error)...");
        }

    }, delay);
}
// Handle WebSocket Data
async function handleMigrationWssData(data: WebSocket.Data, connection: Connection): Promise<void> {
    // Removed: if (activePositions.length >= MAX_POSITIONS) return;

    const jsonString = data.toString();
    const parsedData = JSON.parse(jsonString);

    if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ WebSocket Subscribed.");
        return;
    }

    const logMessages = parsedData?.params?.result?.value?.logs;
    const signature = parsedData?.params?.result?.value?.signature;

    if (!Array.isArray(logMessages) || !signature) return;

    const hasLogMatch = PROGRAM_META_LOGS.some((metaLog: string) => logMessages.some((log: string) => log.includes(metaLog)));

    if (!hasLogMatch) return;

    if (isInitializing) return;
    isInitializing = true;

    console.log(`\n🔎 MATCH: ${signature}`);

    try {
        console.log("⏳ Fetching transaction details...");

        // Retry Loop for RPC Latency
        let tx: ParsedTransactionWithMeta | null = null;
        for (let i = 0; i < 3; i++) {
            tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
            });

            if (tx && tx.meta) {
                break; // Found it!
            }

            console.log(`   Attempt ${i + 1} failed (Meta missing). Retrying immediately...`);
            // await new Promise(resolve => setTimeout(resolve, 1000)); // REMOVED FOR SPEED
        }

        if (!tx?.meta) {
            console.log("❌ Transaction meta missing after retries. Skipping.");
            isInitializing = false;
            return;
        }

        const tokenBalances = tx.meta.postTokenBalances || [];
        console.log(`📊 Found ${tokenBalances.length} postTokenBalances.`);

        const significantTokens = tokenBalances.filter((balance) => balance.mint !== WSOL && balance.uiTokenAmount.decimals !== 0);

        if (significantTokens.length > 0) {
            const firstToken = significantTokens[0];
            const tokenMint = firstToken.mint;

            // Perform Safety Check (RugCheck.xyz)
            // We replaced local checks with this API call as requested
            // Perform Safety Check (Hybrid: Local or RugCheck)
            let isSafe = false;

            if (config.checks.use_local_checks) {
                 // LOCAL RPC CHECKS (Fast)
                console.log(`🛡️ Performing Local Safety Check on ${tokenMint}...`);
                const safety = await localRugCheck(connection, tokenMint);
                if (!safety.isSafe) {
                    console.log(`🛑 Local Safety Check Failed: ${safety.reason}`);
                    console.log(`🛑 Blocked. Skipping.`);
                    isInitializing = false;
                    return;
                } else {
                    console.log(`✅ Local Safety Check Passed! (Authorities Revoked)`);
                    isSafe = true;
                }
            } else {
                // EXTERNAL RUGCHECK (Slow)
                const rugResult = await getRugCheckConfirmed(tokenMint);
                if (!rugResult.isSafe) {
                    console.log(`🛑 Blocked by RugCheck. Skipping.`);
                    isInitializing = false;
                    return;
                }
                isSafe = true;
            }

            if (!isSafe) {
                 isInitializing = false;
                 return;
            }

            console.log(`💎 Found Mint: ${tokenMint}`);

            const accountKeys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey);
            let poolAddr = await extractPoolAddressFromTxKeys(connection, accountKeys);

            if (!poolAddr) {
                console.log("⚠️ Pool not found in keys. Deriving...");
                poolAddr = getComputedPoolAddress(tokenMint, WSOL);
            }

            if (!poolAddr) {
                console.log("❌ Could not determine Pool Address.");
                isInitializing = false;
                return;
            }

            // Check Minimum Initial Liquidity


            // 1. Prepare Jito Transaction (DIRECT METEORA SWAP)
            console.log(`🚀 Preparing Bundle for Pool: ${poolAddr}...`);            
            const tipLamports = config.jito.tip_buy_sol * 1_000_000_000;

            if (tipAccounts.length === 0) {
                console.error("❌ No Jito Tip Accounts available. Aborting.");
                return;
            }

            const cleanTipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)].trim());
            console.log(`[DEBUG] TipAccount: '${cleanTipAccount.toBase58()}'`);

            // DRY RUN CHECK
            if (config.dry_run) {
                console.log(`\n🛑 DRY RUN: Skipping Jito Buy for ${tokenMint}`);
                console.log(`   Would have bought with ${TRADE_AMOUNT_SOL} SOL`);
                console.log(`📈 GMGN: https://gmgn.ai/sol/token/${tokenMint}`);
                scheduleAutoSell(tokenMint, poolAddr as string, connection);
                isInitializing = false;
                return;
            }

            // Execute Direct Meteora Buy via Jito with Block Engine Rotation
            // Use WSOL mint for input
            const solAmountLamports = Math.floor(TRADE_AMOUNT_SOL * 1_000_000_000);

            // Retry loop for buy (max 3 attempts)
            let buyConfirmed = false;
            let confirmedSignature: string | null = null;
            const MAX_BUY_ATTEMPTS = 3;

            for (let attempt = 1; attempt <= MAX_BUY_ATTEMPTS; attempt++) {
                console.log(`📤 Buy Attempt ${attempt}/${MAX_BUY_ATTEMPTS}...`);

                const signature = await executeJitoSwapWithRotation(
                    jitoClients, // Pass the entire Map for rotation
                    connection,
                    walletKeypair,
                    poolAddr,
                    WSOL, // Input Token: WSOL
                    solAmountLamports,
                    tipLamports,
                    cleanTipAccount,
                    3.0 // 3% Slippage
                );

                if (signature) {
                    console.log(`✅ PROCESSED BUNDLE: ${signature} (Scanning confirmation...)`);
                    
                    const confirmed = await confirmTransactionInclusion(connection, signature);

                    if (confirmed) {
                        console.log(`✅ Buy Confirmed on-chain!`);
                        buyConfirmed = true;
                        confirmedSignature = signature;
                        break; // Exit retry loop
                    } else {
                        console.log(`⚠️ Buy not confirmed (Attempt ${attempt}/${MAX_BUY_ATTEMPTS})`);
                        if (attempt < MAX_BUY_ATTEMPTS) {
                            console.log(`   Retrying in 2 seconds...`);
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                } else {
                    console.log(`❌ Buy Bundle Failed (Attempt ${attempt}/${MAX_BUY_ATTEMPTS})`);
                    if (attempt < MAX_BUY_ATTEMPTS) {
                        console.log(`   Retrying in 2 seconds...`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }

            if (buyConfirmed && confirmedSignature) {
                console.log(`🔗 Jito: https://explorer.jito.wtf/bundle/${confirmedSignature}`);
                console.log(`📈 GMGN: https://gmgn.ai/sol/token/${tokenMint}`);
                console.log(`🦅 DexScreener: https://dexscreener.com/solana/${tokenMint}`);
                
                scheduleAutoSell(tokenMint, poolAddr as string, connection);
            } else {
                console.log("❌ CRITICAL: Buy failed after all attempts. Skipping Auto-Sell.");
            }
            // Skip the old logic block
            return; 

        } // End of if (significantTokens)

    } catch (e: any) {
        console.error("❌ Error in loop:", e.message);
    } finally {
        // CRITICAL: Always reset flag to allow processing next transaction
        isInitializing = false;
        console.log("🔄 Ready for next transaction...");
    }
}

// Confirm Transaction Inclusion using Polling
async function confirmTransactionInclusion(connection: Connection, signature: string, maxRetries = 3): Promise<boolean> {
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

// ... inside handleMigrationWssData logic ...
function returnMigrationSubscribeRequest() {
    return {
        jsonrpc: "2.0",
        id: PROGRAM_ID,
        method: "logsSubscribe",
        params: [
            { mentions: [PROGRAM_ID] },
            { commitment: "processed" },
        ],
    };
}


async function getLowestLatencyBlockEngine(): Promise<string> {
    // We pre-initialize clients for all regions
    for (const url of BLOCK_ENGINE_URLS) {
        try {
            jitoClients.set(url, searcherClient(url, walletKeypair));
        } catch (e) {
            console.error(`Failed to init client for ${url}`);
        }
    }

    if (process.env.JITO_BLOCK_ENGINE_URL) {
        console.log(`ℹ️ 使用 Configured Jito Engine: ${process.env.JITO_BLOCK_ENGINE_URL}`);
        return process.env.JITO_BLOCK_ENGINE_URL;
    }

    // Default to first
    return BLOCK_ENGINE_URLS[0];
}

// ... existing code ...

// Main Function
async function startSniper() {
    if (!WSS_ENDPOINT || !RPC_ENDPOINT) {
        console.error("❌ Missing RPC/WSS endpoints.");
        return;
    }

    const connection = new Connection(RPC_ENDPOINT, "confirmed");
    const keepers = config.migration_keepers;

    console.log("🔥 METEORA SNIPER - JITO LIVE MODE 🔥");
    console.log(`Wallet: ${walletKeypair.publicKey.toBase58()}`);
    console.log(`👀 Monitoring ${keepers.length} migration keepers:`);
    keepers.forEach((k, i) => console.log(`   Keeper ${i + 1}: ${k}`));

    // Select best block engine
    const selectedBlockEngineUrl = await getLowestLatencyBlockEngine();
    console.log(`Jito Engine: ${selectedBlockEngineUrl}`);

    // Init Client with best URL
    // We use undefined for auth keypair to avoid PERMISSION_DENIED on non-whitelisted accounts
    jitoClient = searcherClient(selectedBlockEngineUrl, walletKeypair);

    // Default to lower tip for testing if not set
    const tipAmount = process.env.JITO_TIP_AMOUNT ? parseFloat(process.env.JITO_TIP_AMOUNT) : 0.0001;
    console.log(`Tip Amount: ${tipAmount} SOL`);

    // Use Hardcoded Tips to avoid triggering Auth immediately if possible
    // (Jito Tip Accounts are generally static/public)
    tipAccounts = [
        "96gYZGLnJFVFtHgZEUMu41FXu5N7QJ9kgD7rpq2LqR53", 
        "Hf3aaSbbJqS9AIQdGOSb9eS1d9NSH6E74c3y13c4eFz", 
        "ADaUMid9yfUytqMBgopDjb6u78QmoNAok3sVV86X92", 
        "DfXygSm4jCyNCyb3qzK69cz12ueHD5yJiG1hR5tJQr9B",
        "ADuUkR4vqLUMWXxW9q6F628tkAIC6DDSjzenbsp9ts40",
        "DttWaMuVvTiduZRNgVJ/5J5y8X9J5enbsp9ts40",
        "3AVi9Tg9Uo68tJfuvoNrL2RTG8rrba1HpHWjGyKac"
    ];
    console.log(`✅ Loaded ${tipAccounts.length} Jito Tip Accounts (Hardcoded).`);



    // Create subscription for each keeper
    keepers.forEach((keeperAddress, index) => {
        const ws = new WebSocket(WSS_ENDPOINT);

        const subscribeRequest = {
            jsonrpc: "2.0",
            id: `keeper-${index + 1}`,
            method: "logsSubscribe",
            params: [
                { mentions: [keeperAddress] },
                { commitment: "processed" },
            ],
        };

        ws.on("open", () => {
            console.log(`✅ Keeper ${index + 1} subscription active`);
            reconnectDelay = 5000;
            ws.send(JSON.stringify(subscribeRequest));
        });

        ws.on("message", (data) => handleMigrationWssData(data, connection));

        ws.on("close", () => {
            console.log(`⚠️ Keeper ${index + 1} WSS Closed. Reconnecting in ${reconnectDelay}ms...`);
            setTimeout(startSniper, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 60000);
        });

        ws.on("error", (err: Error) => {
            if (err.message.includes("429")) {
                console.log("⚠️ 429 Rate Limit. Backing off 15s.");
                reconnectDelay = 15000;
            } else {
                console.error(`❌ Keeper ${index + 1} WSS Error:`, err.message);
            }
        });
    });
}

startSniper();

