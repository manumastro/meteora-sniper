import WebSocket from "ws";
import dotenv from "dotenv";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import axios from "axios";
import { createSwapTransaction, getComputedPoolAddress, extractPoolAddressFromTxKeys } from "./execution";

// Load environment variables from the .env file
dotenv.config();

// Set Constants
const WSS_ENDPOINT = process.env.SVS_UNSTAKED_WSS || null;
const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC || null;
const PROGRAM_ID = config.program.id;
const PROGRAM_META_LOGS = config.program.meta_logs;
const WSOL = config.wsol_pc_mint;

// Paper Trading Configuration
const PAPER_TRADE_AMOUNT_SOL = 0.01; // Amount in SOL to simulate buying
const MAX_POSITIONS = 100;
const TAKE_PROFIT_PERCENT = 100; // 100% PNL
const PRICE_CHECK_INTERVAL_MS = 2000; // Check price every 2 seconds
const MIN_LIQUIDITY_SOL = 10; // Minimum Liquidity in SOL to trade

interface PaperTrade {
    tokenMint: string;
    entryTime: Date;
    entrySignature: string;
    simulatedSolSpent: number;
    simulatedUsdSpent: number; // Added USD
    simulatedTokenAmount: number;
    entryPrice: number; // SOL per token
    entryPriceUsd: number; // Added USD
    currentPrice: number; // SOL per token
    currentPriceUsd: number; // Added USD
    lastUpdateTime: Date;
    profitLossPercent: number;
    profitLossSol: number;
    profitLossUsd: number; // Added USD
    transactionCount: number; // We'll count API checks instead
    status: 'ACTIVE' | 'CLOSED';
    exitReason?: string;
}

let activeTrades: PaperTrade[] = [];
let closedTrades: PaperTrade[] = [];
let isInitializing = false;
let checkPriceInterval: NodeJS.Timeout | null = null;

// Helper to format price with subscript for zeros (e.g. 0.000000461 -> 0.0₆461)
function formatPrice(price: number): string {
    if (!price || price === 0) return "0.00 SOL";
    if (price >= 0.01) return price.toFixed(6) + " SOL";

    const str = price.toFixed(20); // avoid scientific notation
    const match = str.match(/^0\.(0+)([^0].*)/);

    if (!match) return price.toExponential(4) + " SOL";

    const zerosCount = match[1].length;
    const significantDigits = match[2].substring(0, 4); // keep 4 significant digits

    // If few zeros, just show normally
    if (zerosCount <= 2) return price.toFixed(6) + " SOL";

    // Convert count to subscript
    const subscripts: { [key: string]: string } = {
        '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
        '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'
    };
    const zerosSubscript = zerosCount.toString().split('').map(char => subscripts[char]).join('');

    return `0.0${zerosSubscript}${significantDigits} SOL`;
}

// Display paper trade status
function displayTradeStatus() {
    // Clear console and move cursor to top-left
    console.clear();

    const now = new Date();

    const activePnL = activeTrades.reduce((acc, t) => acc + t.profitLossSol, 0);
    const realizedPnL = closedTrades.reduce((acc, t) => acc + t.profitLossSol, 0);
    const totalPnL = activePnL + realizedPnL;

    console.log("=".repeat(130));
    console.log(`🎮 PAPER TRADING DASHBOARD - ${now.toLocaleTimeString()}`);
    console.log(`Active Positions: ${activeTrades.length}/${MAX_POSITIONS}`);
    console.log(`Active Unrealized PNL: ${activePnL >= 0 ? '+' : ''}${activePnL.toFixed(4)} SOL`);
    console.log(`Total Realized PNL:    ${realizedPnL >= 0 ? '+' : ''}${realizedPnL.toFixed(4)} SOL`);
    console.log(`GRAND TOTAL PNL:       ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} SOL`);
    console.log("=".repeat(130));

    if (activeTrades.length === 0 && closedTrades.length === 0) {
        console.log(`\n⏳ Waiting for token migrations...`);
        return;
    }

    if (activeTrades.length > 0) {
        console.log("\n🚀 ACTIVE TRADES:");
        console.log("-".repeat(130));
        console.log(
            "| GMGN Link (Click to Open)                                        | Time  | Entry (SOL)  | Curr (SOL)   | PNL (%)   | PNL (SOL)"
        );
        console.log("-".repeat(130));

        activeTrades.forEach(trade => {
            const elapsedTime = Math.floor((now.getTime() - trade.entryTime.getTime()) / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            const timeStr = `${minutes}m${seconds}s`;

            const plColor = trade.profitLossPercent >= 0 ? "\x1b[32m" : "\x1b[31m";
            const resetColor = "\x1b[0m";
            const link = `https://gmgn.ai/sol/token/${trade.tokenMint}`;

            // Link is ~66-70 chars
            console.log(
                `| ${link.padEnd(68)} | ${timeStr.padEnd(5)} | ${formatPrice(trade.entryPrice).padEnd(12)} | ${formatPrice(trade.currentPrice).padEnd(12)} | ${plColor}${(trade.profitLossPercent.toFixed(1) + "%").padEnd(9)}${resetColor} | ${plColor}${trade.profitLossSol.toFixed(4)}${resetColor}`
            );
        });
        console.log("-".repeat(130));
    }

    if (closedTrades.length > 0) {
        console.log("\n🏁 CLOSED TRADES (Last 5):");
        console.log("-".repeat(130));
        console.log(
            "| GMGN Link                                                        | Duration | Entry (SOL)  | Exit (SOL)   | PNL (%)   | Reason"
        );
        console.log("-".repeat(130));

        // Show last 5
        const lastTrades = closedTrades.slice(-5).reverse();

        lastTrades.forEach(trade => {
            const timeDiff = trade.lastUpdateTime.getTime() - trade.entryTime.getTime();
            const elapsedTime = Math.floor(timeDiff / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            const timeStr = `${minutes}m${seconds}s`;

            const plColor = trade.profitLossPercent >= 0 ? "\x1b[32m" : "\x1b[31m";
            const resetColor = "\x1b[0m";
            const link = `https://gmgn.ai/sol/token/${trade.tokenMint}`;

            console.log(
                `| ${link.padEnd(68)} | ${timeStr.padEnd(8)} | ${formatPrice(trade.entryPrice).padEnd(12)} | ${formatPrice(trade.currentPrice).padEnd(12)} | ${plColor}${(trade.profitLossPercent.toFixed(1) + "%").padEnd(9)}${resetColor} | ${trade.exitReason}`
            );
        });
        console.log("-".repeat(130));
    }

    console.log("\n" + "=".repeat(130));
    console.log("Press Ctrl+C to stop paper trading");
}

// Fetch prices from DexScreener API (SOL and USD) for multiple tokens
async function getPricesFromDexScreener(tokenMints: string[]): Promise<Map<string, { priceSol: number, priceUsd: number }>> {
    const results = new Map<string, { priceSol: number, priceUsd: number }>();
    if (tokenMints.length === 0) return results;

    try {
        // DexScreener supports up to 30 addresses
        // chunking if necessary could be added, but for 10 max positions it's fine.
        const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMints.join(',')}`;
        const response = await axios.get(url);

        if (response.data?.pairs && Array.isArray(response.data.pairs)) {
            response.data.pairs.forEach((pair: any) => {
                // Check if base token is one of ours
                // Note: DexScreener might return multiple pairs for same token. We want the one with highest liquidity or simply the first one with SOL quote.
                // We need to match pair.baseToken.address with our mints.
                const mint = pair.baseToken.address;
                if (!results.has(mint) && tokenMints.includes(mint)) {
                    // Prefer SOL pair
                    if (pair.quoteToken.address === WSOL || pair.quoteToken.symbol === 'SOL') {
                        results.set(mint, {
                            priceSol: parseFloat(pair.priceNative),
                            priceUsd: parseFloat(pair.priceUsd)
                        });
                    } else {
                        // If we haven't found a SOL pair yet, take this but keep looking for SOL pair? 
                        // For simplicity, take the first valid one, but maybe check if we already have one.
                        // If we already have one that IS NOT SOL pair, and this IS SOL pair, overwrite.
                        // If we don't have one, take it.
                        results.set(mint, {
                            priceSol: parseFloat(pair.priceNative), // This might be wrong if not native SOL, but DexScreener priceNative is usually "price in quote token".
                            // So if quote is USDC, priceNative is USDC price. We need price in SOL.
                            // However, priceUsd is reliable.
                            // If we don't have a SOL pair, we can approximate SOL price if we knew SOL price.
                            // Let's rely on Pairs that are quoted in SOL or have priceUsd.
                            // Actually, if we use priceUsd, we can't easily get priceSol without a reference.
                            // Let's store whatever we have.
                            priceUsd: parseFloat(pair.priceUsd)
                        });
                    }
                }
            });
        }
        return results;
    } catch (error: any) {
        return results;
    }
}

// Calculate token price from transaction based on total volume moved
// This is used ONLY for the initial Entry Price to simulate sniping at block 0
function calculateTokenPrice(tx: ParsedTransactionWithMeta, tokenMint: string): number | null {
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    // Helper to calculate total volume for a specific mint
    const calculateVolume = (mint: string) => {
        // We track pre and post balances for each account index
        const accountMap = new Map<string, { pre: number, post: number }>();

        // Process pre-balances
        preBalances.forEach((b: TokenBalance) => {
            if (b.mint === mint) {
                const amount = parseFloat(b.uiTokenAmount.uiAmountString || "0");
                accountMap.set(b.accountIndex.toString(), { pre: amount, post: 0 });
            }
        });

        // Process post-balances
        postBalances.forEach((b: TokenBalance) => {
            if (b.mint === mint) {
                const amount = parseFloat(b.uiTokenAmount.uiAmountString || "0");
                if (accountMap.has(b.accountIndex.toString())) {
                    const data = accountMap.get(b.accountIndex.toString())!;
                    data.post = amount;
                    accountMap.set(b.accountIndex.toString(), data);
                } else {
                    accountMap.set(b.accountIndex.toString(), { pre: 0, post: amount });
                }
            }
        });

        // Sum deltas (Total change in balances)
        let sumDeltas = 0;
        accountMap.forEach((val) => {
            sumDeltas += Math.abs(val.post - val.pre);
        });

        // The logic is: Total Volume Moved = (Amount Sent + Amount Received).
        // In a swap/migration, Amount Sent should equal Amount Received (roughly).
        // So we divide by 2 to get the "Trading Volume" of that single transaction.
        return sumDeltas / 2;
    };

    const wsolVolume = calculateVolume(WSOL);
    const tokenVolume = calculateVolume(tokenMint);

    // Filter out noise: minimal volumes might be rent or dust
    // WSOL volume must be significant (e.g. > MIN_LIQUIDITY_SOL)
    if (wsolVolume >= MIN_LIQUIDITY_SOL && tokenVolume > 0) {
        return wsolVolume / tokenVolume; // SOL per token
    } else if (wsolVolume > 0 && wsolVolume < MIN_LIQUIDITY_SOL) {
        console.log(`⚠️ Insufficient Liquidity: ${wsolVolume.toFixed(2)} SOL < ${MIN_LIQUIDITY_SOL} SOL`);
    }

    return null;
}

// Fetch transaction with retry logic
async function getTransactionWithRetry(connection: Connection, signature: string, retries = 3): Promise<ParsedTransactionWithMeta | null> {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed",
            });
            if (tx) return tx;
        } catch (error) {
            // console.log(`Retry ${i + 1} failed for ${signature}`);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
    return null;
}

// Loop to check price periodically
// Loop to check price periodically
async function startPriceMonitoring() {
    // Only start one interval
    if (checkPriceInterval) return;

    checkPriceInterval = setInterval(async () => {
        if (activeTrades.length === 0) {
            displayTradeStatus(); // Update "Waiting..." message
            return;
        }

        const mints = activeTrades.map(t => t.tokenMint);
        const pricesMap = await getPricesFromDexScreener(mints);

        activeTrades.forEach(trade => {
            const priceData = pricesMap.get(trade.tokenMint);

            if (priceData && priceData.priceSol > 0) {
                trade.transactionCount++;

                // Initialize Entry Prices if needed (should be done at entry, but safe fallback)
                if (trade.entryPriceUsd === 0 && priceData.priceUsd > 0) {
                    trade.entryPriceUsd = priceData.priceUsd;
                    const solPriceInUsd = priceData.priceUsd / priceData.priceSol;
                    trade.simulatedUsdSpent = trade.simulatedSolSpent * solPriceInUsd;
                }

                trade.currentPrice = priceData.priceSol;
                trade.currentPriceUsd = priceData.priceUsd;
                trade.lastUpdateTime = new Date();

                // Calculate P/L
                const currentValSol = trade.simulatedTokenAmount * trade.currentPrice;
                const currentValUsd = trade.simulatedTokenAmount * trade.currentPriceUsd;

                trade.profitLossSol = currentValSol - trade.simulatedSolSpent;
                trade.profitLossUsd = currentValUsd - trade.simulatedUsdSpent;
                trade.profitLossPercent = (trade.profitLossSol / trade.simulatedSolSpent) * 100;

                // CHECK TAKE PROFIT
                if (trade.profitLossPercent >= TAKE_PROFIT_PERCENT) {
                    trade.status = 'CLOSED';
                    trade.exitReason = `TP Hit (+${trade.profitLossPercent.toFixed(2)}%)`;
                    // Move to closed
                    closedTrades.push(trade);
                }
            }
        });

        // Remove closed trades from active
        activeTrades = activeTrades.filter(t => t.status === 'ACTIVE');

        displayTradeStatus();

    }, PRICE_CHECK_INTERVAL_MS);
}


// Handle migration detection WebSocket data
async function handleMigrationWssData(data: WebSocket.Data, connection: Connection): Promise<boolean> {

    // Check Max Positions
    if (activeTrades.length >= MAX_POSITIONS) {
        // Just log intermittently? Or silence.
        // displayTradeStatus(); // Keep updating dashboard
        return false;
    }
    // Prevent entering same token twice
    // (Optimization could be here)

    const jsonString = data.toString();
    const parsedData = JSON.parse(jsonString);

    // Handle subscription response
    if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ Migration detection active.");
        return false;
    }

    const logMessages = parsedData?.params?.result?.value?.logs;
    const signature = parsedData?.params?.result?.value?.signature;

    if (!Array.isArray(logMessages) || !signature) return false;

    // Find event based on log
    const hasLogMatch = PROGRAM_META_LOGS.some((metaLog) => logMessages.some((log: string) => log.includes(metaLog)));

    if (!hasLogMatch) return false;

    // Lock logic if strictly sequential but we have multiple positions now.
    // We can allow parallel heavy lifting but let's be safe:
    if (isInitializing) return false;
    isInitializing = true;

    console.log(`\n🔎 New migration detected: ${signature}`);

    try {
        // Retry fetching the transaction a few times if it fails (RPC timeout issues)
        const tx = await getTransactionWithRetry(connection, signature, 3);

        if (!tx?.meta) {
            console.log("❌ Failed to fetch transaction details.");
            isInitializing = false;
            return false;
        }

        // Extract Token CA from postTokenBalances
        const tokenBalances = tx.meta.postTokenBalances || [];
        const significantTokens = tokenBalances.filter((balance) => balance.mint !== WSOL && balance.uiTokenAmount.decimals !== 0);

        if (significantTokens.length > 0) {
            const firstToken = significantTokens[0];
            const tokenMint = firstToken.mint;

            // Check if we already traded this token in active or closed (optional, user didn't specify but good practice)
            if (activeTrades.some(t => t.tokenMint === tokenMint)) {
                console.log("⚠️ Token already active. Skipping.");
                isInitializing = false;
                return false;
            }

            // Calculate Entry Price immediately from the migration transaction
            const initialPriceSol = calculateTokenPrice(tx, tokenMint);

            if (activeTrades.length >= MAX_POSITIONS) {
                isInitializing = false;
                return false;
            }

            if (!initialPriceSol || initialPriceSol <= 0) {
                console.log("⚠️ Could not calculate initial price from migration tx. Skipping.");
                isInitializing = false;
                return false;
            }

            console.log(`\n💎 Token found: ${tokenMint}`);
            console.log(`📉 Entry Price: ${formatPrice(initialPriceSol)}`);

            // Initialize Paper Trade
            const newTrade: PaperTrade = {
                tokenMint,
                entryTime: new Date(),
                entrySignature: signature,
                simulatedSolSpent: PAPER_TRADE_AMOUNT_SOL,
                simulatedUsdSpent: 0,
                simulatedTokenAmount: PAPER_TRADE_AMOUNT_SOL / initialPriceSol,
                entryPrice: initialPriceSol,
                entryPriceUsd: 0,
                currentPrice: initialPriceSol,
                currentPriceUsd: 0,
                lastUpdateTime: new Date(),
                profitLossPercent: 0,
                profitLossSol: 0,
                profitLossUsd: 0,
                transactionCount: 0,
                status: 'ACTIVE'
            };

            activeTrades.push(newTrade);
            console.log(`\n🎯 POSITION OPENED! Total Active: ${activeTrades.length}`);

            // --- FAST SWAP SIMULATION (DRY RUN) ---
            const simStart = Date.now();
            (async () => {
                try {
                    let poolAddr: string | null = null;

                    // 1. Try to extract from TX accounts (Most Reliable)
                    // Need to cast to any because TS defs for ParsedTransaction can vary on accountKeys structure
                    const accountKeys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey);
                    console.log(`🧪 Extracting Pool Address from ${accountKeys.length} keys...`);
                    poolAddr = await extractPoolAddressFromTxKeys(connection, accountKeys);

                    // 2. Fallback to Derivation
                    if (!poolAddr) {
                        console.log("⚠️ Could not find pool in TX. Falling back to derivation.");
                        poolAddr = getComputedPoolAddress(tokenMint, WSOL);
                    }

                    if (!poolAddr) {
                        console.log("❌ Failed to identify Pool Address. Skipping Simulation.");
                        return;
                    }

                    console.log(`🧪 Simulating Fast Swap on Pool: ${poolAddr}`);

                    // Use a random payer
                    const simPayer = Keypair.generate();
                    const swapLamports = Math.floor(PAPER_TRADE_AMOUNT_SOL * 1_000_000_000);

                    const res = await createSwapTransaction(connection, simPayer.publicKey, poolAddr, WSOL, swapLamports);
                    const duration = Date.now() - simStart;

                    if (res) {
                        console.log(`⚡ [SIMULATION SUCCESS] Swap Tx Built in ${duration}ms! Est Out: ${res.estimatedOutput} tokens`);
                    } else {
                        console.error(`❌ [SIMULATION FAILED] Could not build Swap Tx in ${duration}ms. Stopping execution.`);
                        process.exit(1);
                    }

                } catch (simErr) {
                    console.error("❌ Simulation setup failed FATAL:", simErr);
                    process.exit(1);
                }
            })();
            // --------------------------------------

            // Ensure monitoring is running
            startPriceMonitoring();

            isInitializing = false;
            return true;
        }
    } catch (error) {
        console.error("❌ Error during trade initialization", error);
    }

    isInitializing = false;
    return false;
}

// Return subscribe request for migration detection
function returnMigrationSubscribeRequest() {
    return {
        jsonrpc: "2.0",
        id: PROGRAM_ID,
        method: "logsSubscribe",
        params: [
            {
                mentions: [PROGRAM_ID],
            },
            {
                commitment: "processed",
            },
        ],
    };
}

// Main WebSocket connection
async function startPaperTrading(): Promise<void> {
    if (!WSS_ENDPOINT || !RPC_ENDPOINT) {
        console.log("❌ Missing WSS or RPC endpoint.");
        return;
    }

    // Setup Connection for getting the initial transaction details
    const connection = new Connection(RPC_ENDPOINT, "confirmed");

    console.log("\n" + "=".repeat(80));
    console.log("🎮 PAPER TRADING MODE (JUPITER API EDITION)");
    console.log("=".repeat(80));
    console.log(`💰 Simulated investment per trade: ${PAPER_TRADE_AMOUNT_SOL} SOL`);
    console.log(`🎯 Waiting for first token migration...`);
    console.log("=".repeat(80) + "\n");

    // WebSocket for migration detection
    let migrationWsClient: WebSocket | null = new WebSocket(WSS_ENDPOINT);
    const migrationRequest = returnMigrationSubscribeRequest();

    try {
        // Setup migration detection WebSocket
        migrationWsClient.on("message", (data) => handleMigrationWssData(data, connection));
        migrationWsClient.on("open", () => {
            migrationWsClient!.send(JSON.stringify(migrationRequest));
        });
        migrationWsClient.on("close", () => {
            console.log("🔐 Migration WebSocket closed. Reconnecting in 5 seconds...");
            setTimeout(() => startPaperTrading(), 5000);
        });
        migrationWsClient.on("error", (error: Error) => {
            console.log("❌ Migration WebSocket error:", error.message);
        });

    } catch (error) {
        console.error("❌ Error during WebSocket setup:", error);
        migrationWsClient?.close();
    }
}

// Start
startPaperTrading();
