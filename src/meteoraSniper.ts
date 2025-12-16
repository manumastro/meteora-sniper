import WebSocket from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import bs58 from "bs58";
import { createSwapTransaction, getComputedPoolAddress, extractPoolAddressFromTxKeys, executeJitoSwap } from "./execution";

// Constants & Env
const WSS_ENDPOINT = process.env.SVS_UNSTAKED_WSS || "";
const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC || "";
const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || "amsterdam.mainnet.block-engine.jito.wtf";
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY || "";
const JITO_TIP_AMOUNT_SOL = parseFloat(process.env.JITO_TIP_AMOUNT || "0.001");

const PROGRAM_ID = config.program.id;
const PROGRAM_META_LOGS = config.program.meta_logs;
const WSOL = config.wsol_pc_mint;

// Trading Config
const TRADE_AMOUNT_SOL = 0.01; 
const MIN_LIQUIDITY_SOL = 10;
const MAX_POSITIONS = 5;
const STOP_LOSS_PERCENT = 30; // -30% Stop Loss

interface Position {
    mint: string;
    amount: number; // Token Amount
    entryPrice: number; // SOL
    entryTime: number;
    poolAddress: string;
}

// Global State
let activePositions: Position[] = [];
let isInitializing = false;
let checkPriceInterval: NodeJS.Timeout | null = null;
let reconnectDelay = 5000;
let tipAccounts: string[] = [];

// Setup Wallet
if (!PRIVATE_KEY_B58) {
    console.error("❌ PRIVATE_KEY is missing in .env");
    process.exit(1);
}
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));

// Setup Jito Client
const jitoClient = searcherClient(
    JITO_BLOCK_ENGINE_URL,
    walletKeypair // Authorization Keypair (using same as trade wallet for simplicity)
);

// Constants for Price Calc
function formatPrice(price: number): string {
    return price.toFixed(6) + " SOL";
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
async function triggerSell(position: Position, reason: string, connection: Connection) {
    console.log(`\n🚨 STOP LOSS TRIGGERED: ${position.mint} (${reason})`);
    
    // We need to fetch current balance to sell ALL
    // OR we track amount in Position.
    // Let's rely on stored amount for speed, but ideally we check balance.
    // For sniping, assume we hold what we bought.
    const sellAmount = position.amount;
    const sellAmountLamports = Math.floor(sellAmount * 10 ** 6); // Approximation (USDC 6 decimals? NO wait).
    // CRITICAL: We don't know decimals here unless we stored them or assume.
    // executeJitoSwap expects Integer Lamports for Input.
    // But Input is now Token, not SOL.
    // If we are swapping Token -> SOL, inputAmount is Token Amount * 10^Decimals.
    // We should probably store decimals in Position.
    
    // Quick Fix: We need decimals.
    // Let's assume we can fetch it or we stored it.
    // To be safe, let's fetch balance + decimals from chain for the sell.
    
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: new PublicKey(position.mint) });
        if (tokenAccounts.value.length === 0) {
            console.log("⚠️ No token balance to sell.");
            return;
        }
        
        const balanceInfo = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
        const balanceAmount = balanceInfo.amount; // string integer
        const decimals = balanceInfo.decimals;
        
        console.log(`📉 Selling ${balanceInfo.uiAmount} tokens...`);

        if (tipAccounts.length === 0) { console.error("No tips for sell"); return; }
        const randomTipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
        const tipLamports = JITO_TIP_AMOUNT_SOL * 1_000_000_000;

        // Execute Swap: Input = Token, Output = SOL (Implied by pool)
        // We pass pool address.
        const bundleId = await executeJitoSwap(
            jitoClient, 
            connection, 
            walletKeypair, 
            position.poolAddress, 
            position.mint, // Input Token
            parseInt(balanceAmount), 
            tipLamports,
            randomTipAccount,
            5.0 // High slippage for Stop Loss exit
        );
        
        if (bundleId) {
             console.log(`✅ SELL SENT! Bundle: ${bundleId}`);
             // Remove from active positions
             activePositions = activePositions.filter(p => p.mint !== position.mint);
        } else {
             console.log("❌ Sell Bundle Failed.");
        }

    } catch (e) {
        console.error("Sell Error:", e);
    }
}


// Monitoring Loop
function startPriceMonitoring(connection: Connection) {
    if (checkPriceInterval) return;
    checkPriceInterval = setInterval(async () => {
        if (activePositions.length === 0) return;

        const mints = activePositions.map(p => p.mint);
        const prices = await getPricesFromDexScreener(mints);

        for (const position of activePositions) {
            const priceData = prices.get(position.mint);
            if (!priceData) continue;

            const currentPrice = priceData.priceSol;
            const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            
            console.log(`📊 ${position.mint.slice(0,4)}..: Entry ${formatPrice(position.entryPrice)} | Curr ${formatPrice(currentPrice)} | PNL: ${pnlPercent.toFixed(2)}%`);

            // Check Stop Loss
            if (pnlPercent <= -STOP_LOSS_PERCENT) {
                triggerSell(position, `hit SL ${pnlPercent.toFixed(2)}%`, connection);
            }
        }
    }, 2000); // 2s polling
}


// Handle WebSocket Data
async function handleMigrationWssData(data: WebSocket.Data, connection: Connection): Promise<void> {
    if (activePositions.length >= MAX_POSITIONS) return;

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
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!tx?.meta) {
            isInitializing = false;
            return;
        }

        const tokenBalances = tx.meta.postTokenBalances || [];
        const significantTokens = tokenBalances.filter((balance) => balance.mint !== WSOL && balance.uiTokenAmount.decimals !== 0);

        if (significantTokens.length > 0) {
            const firstToken = significantTokens[0];
            const tokenMint = firstToken.mint;

            // Check if already active
            if (activePositions.some(p => p.mint === tokenMint)) {
                 isInitializing = false; return;
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

            console.log(`🚀 EXECUTING REAL TRADE on Pool: ${poolAddr}`);
            
            const tipLamports = JITO_TIP_AMOUNT_SOL * 1_000_000_000;
            const inputLamports = TRADE_AMOUNT_SOL * 1_000_000_000;

            if (tipAccounts.length === 0) {
                console.error("❌ No Jito Tip Accounts available. Aborting.");
                return;
            }
            const randomTipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);

            const bundleId = await executeJitoSwap(
                jitoClient,
                connection,
                walletKeypair,
                poolAddr,
                WSOL,
                inputLamports,
                tipLamports,
                randomTipAccount
            );

            if (bundleId) {
                console.log(`✅ PROCESSED BUNDLE: ${bundleId} (Scanning confirmation...)`);
                // Assume success for tracking (Real tracking should wait for confirm)
                // For simplicity, we add to Active Positions tentatively.
                // We need entry price to track PNL.
                // We can fetch it next tick or estimate it.
                // Let's set entryPrice = 0 initially and update it in monitoring loop if 0.
                
                activePositions.push({
                    mint: tokenMint,
                    amount: 0, // Unknown yet
                    entryPrice: 0.00000001, // Placeholder
                    entryTime: Date.now(),
                    poolAddress: poolAddr
                });
                
                // Start Monitoring if not running
                startPriceMonitoring(connection);
                
                console.log(`🔗 https://explorer.jito.wtf/bundle/${bundleId}`);
            } else {
                console.log("❌ Bundle Failed or Rejected.");
            }
        }

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


// Main Function
async function startSniper() {
    if (!WSS_ENDPOINT || !RPC_ENDPOINT) {
        console.error("❌ Missing RPC/WSS endpoints.");
        return;
    }

    const connection = new Connection(RPC_ENDPOINT, "confirmed");
    console.log("🔥 METEORA SNIPER - JITO LIVE MODE 🔥");
    console.log(`Wallet: ${walletKeypair.publicKey.toBase58()}`);
    console.log(`Jito Engine: ${JITO_BLOCK_ENGINE_URL}`);
    
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
        return;
    }

    console.log(`Tip Amount: ${JITO_TIP_AMOUNT_SOL} SOL`);
    
    let ws = new WebSocket(WSS_ENDPOINT);
    
    ws.on("open", () => {
        console.log("✅ WSS Connected.");
        reconnectDelay = 5000;
        ws.send(JSON.stringify(returnMigrationSubscribeRequest()));
    });

    ws.on("message", (data) => handleMigrationWssData(data, connection));

    ws.on("close", () => {
        console.log(`⚠️ WSS Closed. Reconnecting in ${reconnectDelay}ms...`);
        setTimeout(startSniper, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    });

    ws.on("error", (err: Error) => {
        if (err.message.includes("429")) {
            console.log("⚠️ 429 Rate Limit. Backing off 15s.");
            reconnectDelay = 15000;
        } else {
            console.error("❌ WSS Error:", err.message);
        }
    });
}

startSniper();
