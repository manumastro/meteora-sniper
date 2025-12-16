import WebSocket from "ws";
import dotenv from "dotenv";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import bs58 from "bs58";
import { createSwapTransaction, getComputedPoolAddress, extractPoolAddressFromTxKeys, executeJitoSwap } from "./execution";

// Load environment variables
dotenv.config();

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
const TRADE_AMOUNT_SOL = 0.01; // Fixed trade amount for now, or move to .env
const MIN_LIQUIDITY_SOL = 10;
const MAX_POSITIONS = 5; // Safety limit

// Global State
let activePositions = 0;
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

// Handle WebSocket Data
async function handleMigrationWssData(data: WebSocket.Data, connection: Connection): Promise<void> {
    if (activePositions >= MAX_POSITIONS) return;

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
        // Fetch Transaction
        // Optimistic approach: We can try to derive pool address purely from logs if possible, 
        // but fetching TX is safer to confirm it's a valid migration with liquidity.
        // To be faster, we might skip full parsing if we can get keys from 'getTransaction' (lighter than getParsedTransaction?)
        // But for now, stick to robust logic.
        
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!tx?.meta) {
            isInitializing = false;
            return;
        }

        // Logic to extract token mint (same as paper mode)
        const tokenBalances = tx.meta.postTokenBalances || [];
        const significantTokens = tokenBalances.filter((balance) => balance.mint !== WSOL && balance.uiTokenAmount.decimals !== 0);

        if (significantTokens.length > 0) {
            const firstToken = significantTokens[0];
            const tokenMint = firstToken.mint;

            console.log(`💎 Found Mint: ${tokenMint}`);

            // 1. Identify Pool Address
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
            
            // 2. Execute Jito Bundle
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
                console.log(`✅ Bundle Sent! ID: ${bundleId}`);
                console.log(`🔗 https://explorer.jito.wtf/bundle/${bundleId}`);
                activePositions++;
            } else {
                console.log("❌ Bundle Failed or Rejected.");
            }
        }

    } catch (e: any) {
        console.error("❌ Error in loop:", e.message);
    }
    
    isInitializing = false;
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
