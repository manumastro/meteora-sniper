import WebSocket from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import bs58 from "bs58";
import { getComputedPoolAddress, extractPoolAddressFromTxKeys, executeJitoSwap, prepareJitoTransaction } from "./execution";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

import { SellService, SellStrategy } from "./services/sellService";

dotenv.config();

// Constants & Env
const WSS_ENDPOINT = process.env.SVS_UNSTAKED_WSS;
const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC;
const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL;
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY;
const JITO_TIP_AMOUNT_SOL = parseFloat("0.0001");

const PROGRAM_ID = config.program.id;
const PROGRAM_META_LOGS = config.program.meta_logs;
const WSOL = config.wsol_pc_mint;

// Trading Config
const TRADE_AMOUNT_SOL = 0.001; 
const MIN_LIQUIDITY_SOL = 10;
const MAX_POSITIONS = 1;

// RugCheck Integration
import { getRugCheckConfirmed } from "./utils/rugCheck";

// CheckRugCheckScore is now replaced by getRugCheckConfirmed
// Wrapper to maintain similarity or just use new function directly
async function checkRugCheckScore(mintAddress: string): Promise<boolean> {
    const MAX_RETRIES = 10; // Wait up to ~20 seconds
    const DELAY_MS = 2000;

    for (let i = 0; i < MAX_RETRIES; i++) {
        const isSafe = await getRugCheckConfirmed(mintAddress);
        if (isSafe) return true;

        console.log(`⏳ RugCheck failed or missing data. Retrying in ${DELAY_MS/1000}s... (Attempt ${i + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
    
    return false;
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



// Constants for Price Calc
function formatPrice(price: number): string {
    return price.toFixed(10) + " SOL";
}

// Helper to get prices
async function getPricesFromDexScreener(tokenMints: string[]): Promise<Map<string, { priceSol: number, priceUsd: number }>> {
    const results = new Map<string, { priceSol: number, priceUsd: number }>();
    if (tokenMints.length === 0) return results;
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMints.join(',')}`;
        const response = await axios.get(url);
        if (response.data?.pairs && Array.isArray(response.data.pairs)) {
            response.data.pairs.forEach((pair: any) => {
                const mint = pair.baseToken.address;
                if (!results.has(mint) && tokenMints.includes(mint)) {
                     if (pair.quoteToken.symbol === 'SOL') {
                        results.set(mint, { priceSol: parseFloat(pair.priceNative), priceUsd: parseFloat(pair.priceUsd) });
                     } else {
                        // Fallback
                        results.set(mint, { priceSol: parseFloat(pair.priceNative), priceUsd: parseFloat(pair.priceUsd) });
                     }
                }
            });
        }
    } catch (e) { console.error("DetScreener Error", e); }
    return results;
}
// Sell Logic
// Sell Logic (Delegated to Service)
// OLD triggerSell removed.


// Scheduled Auto-Sell (Blind)
function scheduleAutoSell(mint: string, poolAddress: string, connection: Connection) {
    const delay = config.sell.auto_sell_delay_ms;
    console.log(`⏱️ Auto-Sell scheduled for ${mint} in ${delay/1000}s...`);

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
                const bundleId = await SellService.executeSell(
                     connection,
                     walletKeypair,
                     mint,
                     parseInt(balance),
                     poolAddress,
                     SellStrategy.JUPITER, 
                     jitoClients,
                     jitoClient,
                     tipAccounts
                );
                if (bundleId) {
                     console.log(`✅ Auto Sell Bundle Sent: ${bundleId}`);
                } else {
                     console.log("❌ Auto Sell Bundle Failed.");
                }
            } else {
                console.log("⚠️ No balance found to sell (Buy likely failed or RPC lag).");
            }
        } catch (e) {
            console.error("❌ Auto-Sell Error:", e);
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
            const isSafe = await checkRugCheckScore(tokenMint);
            if (!isSafe) {
                console.log("🛑 Blocked by RugCheck. Skipping.");
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
            const poolTokens = tx.meta.postTokenBalances?.filter(b => b.owner === poolAddr) || [];
            const wsolBalanceObj = poolTokens.find(b => b.mint === WSOL);
            const poolLiquiditySol = wsolBalanceObj ? wsolBalanceObj.uiTokenAmount.uiAmount || 0 : 0;

            console.log(`💧 Pool Liquidity Detected: ${poolLiquiditySol} SOL`);
            
            // Re-added for Smart Recovery
            const allWsol = tx.meta.postTokenBalances?.filter(b => b.mint === WSOL) || [];
            
            if (poolLiquiditySol < MIN_LIQUIDITY_SOL) {
                console.log(`⚠️ Low Liquidity Detected in ${poolAddr} (< ${MIN_LIQUIDITY_SOL} SOL).`);
                
                // Smart Pool Recovery
                const highLiquidityAccount = allWsol.find(b => b.uiTokenAmount.uiAmount && b.uiTokenAmount.uiAmount > MIN_LIQUIDITY_SOL);
                if (highLiquidityAccount) {
                    console.log(`💡 Smart Recovery: Found account ${highLiquidityAccount.owner} with ${highLiquidityAccount.uiTokenAmount.uiAmount} SOL. Switching Pool Address.`);
                    poolAddr = highLiquidityAccount.owner || null;
                } else {
                    console.log("⚠️ WARNING: Proceeding anyway due to potential detection bug (User Request).");
                }
            }

            // 1. Prepare Jito Transaction ONCE
            console.log(`🚀 Preparing Bundle for Pool: ${poolAddr}...`);
            const tipLamports = JITO_TIP_AMOUNT_SOL * 1_000_000_000;
            const inputLamports = TRADE_AMOUNT_SOL * 1_000_000_000;

            if (tipAccounts.length === 0) {
                console.error("❌ No Jito Tip Accounts available. Aborting.");
                return;
            }
            
            // Fix potential whitespace/base58 issues
            const cleanTipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)].trim();
            const cleanPoolAddr = (poolAddr as string).trim();
            
            console.log(`[DEBUG] PoolAddr: '${cleanPoolAddr}'`);
            console.log(`[DEBUG] TipAccount: '${cleanTipAccount}'`);

            const vTx = await prepareJitoTransaction(
                connection,
                walletKeypair,
                cleanPoolAddr,
                WSOL,
                inputLamports,
                tipLamports,
                new PublicKey(cleanTipAccount)
            );

            if (!vTx) {
                console.error("❌ Failed to build Jito Transaction.");
                isInitializing = false;
                return;
            }

            let bundleId: string | null = null;
            const bundle = new Bundle([vTx], 5);
            
            // DRY RUN CHECK
            if (config.dry_run) {
                console.log(`\n🛑 DRY RUN: Skipping Jito Bundle Send for ${tokenMint}`);
                console.log(`   Would have bought with ${TRADE_AMOUNT_SOL} SOL`);
                console.log(`🔗 Jito (Simulated): https://explorer.jito.wtf/bundle/SIMULATED`);
                console.log(`📈 GMGN: https://gmgn.ai/sol/token/${tokenMint}`);
                console.log(`🦅 DexScreener: https://dexscreener.com/solana/${tokenMint}`);
                console.log(`⚡ Photon: https://photon-sol.tinyastro.io/en/lp/${poolAddr}`);
                
                // Monitor (Simulated)
                scheduleAutoSell(tokenMint, poolAddr as string, connection);

                isInitializing = false;
                return;
            }

            // 2. FAILOVER ROTATION (Fast Send)
            for (const engineUrl of BLOCK_ENGINE_URLS) {
                console.log(`⚡ Sending Bundle via ${engineUrl}...`);
                try {
                    const searcher = jitoClients.get(engineUrl) || searcherClient(engineUrl, undefined);
                    const result = await searcher.sendBundle(bundle);
                    
                    // @ts-ignore
                    if (result && result.value) {
                        // @ts-ignore
                        bundleId = result.value;
                        console.log(`✅ Bundle Accepted by ${engineUrl}: ${bundleId}`);
                        
                        // Schedule Auto Sell
                        scheduleAutoSell(tokenMint, poolAddr as string, connection);
                        
                        break; 
                    } else {
                        // @ts-ignore
                        console.log(`❌ Rejected by ${engineUrl}:`, result);
                    }
                } catch (e: any) {
                    console.log(`❌ Error via ${engineUrl}:`, e.message);
                }
            }

            if (bundleId) {
                console.log(`✅ PROCESSED BUNDLE: ${bundleId} (Scanning confirmation...)`);
                // Assume success for tracking (Real tracking should wait for confirm)
            }

            if (bundleId) {
                console.log(`✅ PROCESSED BUNDLE: ${bundleId} (Scanning confirmation...)`);
                console.log(`🔗 Jito: https://explorer.jito.wtf/bundle/${bundleId}`);
                console.log(`📈 GMGN: https://gmgn.ai/sol/token/${tokenMint}`);
                console.log(`🦅 DexScreener: https://dexscreener.com/solana/${tokenMint}`);
                console.log(`⚡ Photon: https://photon-sol.tinyastro.io/en/lp/${poolAddr}`);
            } else {
                console.log("❌ Bundle Failed or Rejected.");
            }
        } // End of if (significantTokens)

    } catch (e: any) {
        console.error("❌ Error in loop:", e.message);
    }
    
    isInitializing = false;
}

// Return subscribe request
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
            jitoClients.set(url, searcherClient(url, undefined));
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
    jitoClient = searcherClient(selectedBlockEngineUrl, undefined);

    // Default to lower tip for testing if not set
    const tipAmount = process.env.JITO_TIP_AMOUNT ? parseFloat(process.env.JITO_TIP_AMOUNT) : 0.0001;
    console.log(`Tip Amount: ${tipAmount} SOL`);
    
    try {
        const tips = await jitoClient.getTipAccounts();
        if (Array.isArray(tips)) {
            tipAccounts = tips;
        } else {
             // @ts-ignore
             if (tips.value) tipAccounts = tips.value;
             // @ts-ignore
             else if (tips.ok && tips.value) tipAccounts = tips.value;
             else throw new Error("Could not fetch tip accounts");
        }
        console.log(`✅ Loaded ${tipAccounts.length} Jito Tip Accounts.`);
    } catch (e) {
        console.error("❌ Failed to fetch Jito Tip Accounts:", e);
        // Fallback to hardcoded tip accounts
        tipAccounts = [
            "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNy75ua53PNP8v",
            "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
            "Cw8CFyM9FkoPhlbnF5uehT4Fv1PALKE7y1rD96qlUjhG",
            "ADaUMid9yfUytqMBgopDjb6u785b8rTb3Nau35ofoi02",
            "DfXygSm4jCyNCyb3qzK69cz12ueHD5yJiG1hR5tJQr9B",
            "ADuUkR4ykGytmZqK5QfN97wWzKLBhO8aa5tPwaNdFh5d",
            "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
            "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnIzE60Pl"
        ].map(t => t.trim());
        console.log(`⚠️ Using ${tipAccounts.length} HARDCODED Jito Tip Accounts.`);
        // return; // Don't return, continue with hardcoded
    }

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

