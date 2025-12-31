import WebSocket from "ws";
import dotenv from "dotenv";
import { config } from "./config";
import { Connection, PublicKey, Keypair, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import axios from "axios";
import { createSwapTransaction, getComputedPoolAddress, extractPoolAddressFromTxKeys } from "./execution";

dotenv.config();

const WSS_ENDPOINT = process.env.SVS_UNSTAKED_WSS || null;
const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC || null;
const PROGRAM_ID = config.program.id;
const PROGRAM_META_LOGS = config.program.meta_logs;
const WSOL = config.wsol_pc_mint;

const PAPER_TRADE_AMOUNT_SOL = 0.01;
const MAX_POSITIONS = 100;
const TAKE_PROFIT_PERCENT = 100;
const PRICE_CHECK_INTERVAL_MS = 2000;
const MIN_LIQUIDITY_SOL = 10;

interface PaperTrade {
    tokenMint: string;
    entryTime: Date;
    entrySignature: string;
    simulatedSolSpent: number;
    simulatedUsdSpent: number;
    simulatedTokenAmount: number;
    entryPrice: number;
    entryPriceUsd: number;
    currentPrice: number;
    currentPriceUsd: number;
    lastUpdateTime: Date;
    profitLossPercent: number;
    profitLossSol: number;
    profitLossUsd: number;
    transactionCount: number;
    status: 'ACTIVE' | 'CLOSED';
    exitReason?: string;
}

let activeTrades: PaperTrade[] = [];
let closedTrades: PaperTrade[] = [];
let isInitializing = false;
let checkPriceInterval: NodeJS.Timeout | null = null;

function formatPriceSol(price: number): string {
    if (!price || price === 0) return "0.00";
    if (price >= 0.01) return price.toFixed(4);

    // GMGN-style subscript format: 0.0₅654 means 0.00000654
    const str = price.toFixed(20);
    const match = str.match(/^0\.(0+)([1-9]\d*)/);

    if (!match) return price.toExponential(2);

    const zerosCount = match[1].length;
    const significantDigits = match[2].substring(0, 4);

    if (zerosCount <= 2) return price.toFixed(zerosCount + 4);

    const subscripts: { [key: string]: string } = {
        '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
        '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'
    };
    const zerosSubscript = zerosCount.toString().split('').map(char => subscripts[char]).join('');

    return `0.0${zerosSubscript}${significantDigits}`;
}

function formatPriceUsd(price: number): string {
    if (!price || price === 0) return "$0.00";
    if (price >= 1) return "$" + price.toFixed(2);
    if (price >= 0.01) return "$" + price.toFixed(4);
    return "$" + price.toFixed(6);
}

function displayTradeStatus() {
    console.clear();

    const now = new Date();

    const activePnL = activeTrades.reduce((acc, t) => acc + t.profitLossSol, 0);
    const activePnLUsd = activeTrades.reduce((acc, t) => acc + t.profitLossUsd, 0);
    const realizedPnL = closedTrades.reduce((acc, t) => acc + t.profitLossSol, 0);
    const realizedPnLUsd = closedTrades.reduce((acc, t) => acc + t.profitLossUsd, 0);
    const totalPnL = activePnL + realizedPnL;
    const totalPnLUsd = activePnLUsd + realizedPnLUsd;

    console.log("=".repeat(180));
    console.log(`🎮 PAPER TRADING DASHBOARD - ${now.toLocaleTimeString()}`);
    console.log(`Active Positions: ${activeTrades.length}/${MAX_POSITIONS}`);
    console.log(`Active Unrealized PNL: ${activePnL >= 0 ? '+' : ''}${activePnL.toFixed(4)} SOL (${activePnLUsd >= 0 ? '+' : ''}${formatPriceUsd(activePnLUsd)})`);
    console.log(`Total Realized PNL:    ${realizedPnL >= 0 ? '+' : ''}${realizedPnL.toFixed(4)} SOL (${realizedPnLUsd >= 0 ? '+' : ''}${formatPriceUsd(realizedPnLUsd)})`);
    console.log(`GRAND TOTAL PNL:       ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} SOL (${totalPnLUsd >= 0 ? '+' : ''}${formatPriceUsd(totalPnLUsd)})`);
    console.log("=".repeat(180));

    if (activeTrades.length === 0 && closedTrades.length === 0) {
        console.log(`\n⏳ Waiting for token migrations...`);
        return;
    }

    if (activeTrades.length > 0) {
        console.log("\n🚀 ACTIVE TRADES:");
        console.log("-".repeat(180));
        console.log(
            "| GMGN Link (Click to Open)                                        | Entry    | Age    | Entry SOL    | Entry USD  | Curr SOL     | Curr USD   | PNL (%)   | PNL (SOL)"
        );
        console.log("-".repeat(180));

        activeTrades.forEach(trade => {
            const elapsedTime = Math.floor((now.getTime() - trade.entryTime.getTime()) / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            const timeStr = `${minutes}m${seconds}s`;
            const entryTimeStr = trade.entryTime.toLocaleTimeString('it-IT', { hour12: false });

            const plColor = trade.profitLossPercent >= 0 ? "\x1b[32m" : "\x1b[31m";
            const resetColor = "\x1b[0m";
            const link = `https://gmgn.ai/sol/token/${trade.tokenMint}`;

            console.log(
                `| ${link.padEnd(68)} | ${entryTimeStr.padEnd(8)} | ${timeStr.padEnd(6)} | ${formatPriceSol(trade.entryPrice).padEnd(12)} | ${formatPriceUsd(trade.entryPriceUsd).padEnd(10)} | ${formatPriceSol(trade.currentPrice).padEnd(12)} | ${formatPriceUsd(trade.currentPriceUsd).padEnd(10)} | ${plColor}${(trade.profitLossPercent.toFixed(1) + "%").padEnd(9)}${resetColor} | ${plColor}${trade.profitLossSol.toFixed(4)}${resetColor}`
            );
        });
        console.log("-".repeat(180));
    }

    if (closedTrades.length > 0) {
        console.log("\n🏁 CLOSED TRADES (Last 5):");
        console.log("-".repeat(180));
        console.log(
            "| GMGN Link                                                        | Entry    | Duration | Entry SOL    | Entry USD  | Exit SOL     | Exit USD   | PNL (%)   | Reason"
        );
        console.log("-".repeat(180));

        const lastTrades = closedTrades.slice(-5).reverse();

        lastTrades.forEach(trade => {
            const timeDiff = trade.lastUpdateTime.getTime() - trade.entryTime.getTime();
            const elapsedTime = Math.floor(timeDiff / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            const timeStr = `${minutes}m${seconds}s`;
            const entryTimeStr = trade.entryTime.toLocaleTimeString('it-IT', { hour12: false });

            const plColor = trade.profitLossPercent >= 0 ? "\x1b[32m" : "\x1b[31m";
            const resetColor = "\x1b[0m";
            const link = `https://gmgn.ai/sol/token/${trade.tokenMint}`;

            console.log(
                `| ${link.padEnd(68)} | ${entryTimeStr.padEnd(8)} | ${timeStr.padEnd(8)} | ${formatPriceSol(trade.entryPrice).padEnd(12)} | ${formatPriceUsd(trade.entryPriceUsd).padEnd(10)} | ${formatPriceSol(trade.currentPrice).padEnd(12)} | ${formatPriceUsd(trade.currentPriceUsd).padEnd(10)} | ${plColor}${(trade.profitLossPercent.toFixed(1) + "%").padEnd(9)}${resetColor} | ${trade.exitReason}`
            );
        });
        console.log("-".repeat(180));
    }

    console.log("\n" + "=".repeat(180));
    console.log("Press Ctrl+C to stop paper trading");
}

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
                    if (pair.quoteToken.address === WSOL || pair.quoteToken.symbol === 'SOL') {
                        results.set(mint, {
                            priceSol: parseFloat(pair.priceNative),
                            priceUsd: parseFloat(pair.priceUsd)
                        });
                    } else {
                        results.set(mint, {
                            priceSol: parseFloat(pair.priceNative),
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

function calculateTokenPrice(tx: ParsedTransactionWithMeta, tokenMint: string): number | null {
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    const calculateVolume = (mint: string) => {
        const accountMap = new Map<string, { pre: number, post: number }>();

        preBalances.forEach((b: TokenBalance) => {
            if (b.mint === mint) {
                const amount = parseFloat(b.uiTokenAmount.uiAmountString || "0");
                accountMap.set(b.accountIndex.toString(), { pre: amount, post: 0 });
            }
        });

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

        let sumDeltas = 0;
        accountMap.forEach((val) => {
            sumDeltas += Math.abs(val.post - val.pre);
        });

        return sumDeltas / 2;
    };

    const wsolVolume = calculateVolume(WSOL);
    const tokenVolume = calculateVolume(tokenMint);

    if (wsolVolume >= MIN_LIQUIDITY_SOL && tokenVolume > 0) {
        return wsolVolume / tokenVolume; // SOL per token
    } else if (wsolVolume > 0 && wsolVolume < MIN_LIQUIDITY_SOL) {
        console.log(`⚠️ Insufficient Liquidity: ${wsolVolume.toFixed(2)} SOL < ${MIN_LIQUIDITY_SOL} SOL`);
    }

    return null;
}
async function getTransactionWithRetry(connection: Connection, signature: string, retries = 3): Promise<ParsedTransactionWithMeta | null> {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed",
            });
            if (tx) return tx;
        } catch (error) {
            await new Promise(res => setTimeout(res, 1000));
        }
    }
    return null;
}

async function startPriceMonitoring() {
    if (checkPriceInterval) return;

    checkPriceInterval = setInterval(async () => {
        if (activeTrades.length === 0) {
            displayTradeStatus();
            return;
        }

        const mints = activeTrades.map(t => t.tokenMint);
        const pricesMap = await getPricesFromDexScreener(mints);

        activeTrades.forEach(trade => {
            const priceData = pricesMap.get(trade.tokenMint);

            if (priceData && priceData.priceSol > 0) {
                trade.transactionCount++;
                if (trade.entryPriceUsd === 0 && priceData.priceUsd > 0) {
                    trade.entryPriceUsd = priceData.priceUsd;
                    const solPriceInUsd = priceData.priceUsd / priceData.priceSol;
                    trade.simulatedUsdSpent = trade.simulatedSolSpent * solPriceInUsd;
                }

                trade.currentPrice = priceData.priceSol;
                trade.currentPriceUsd = priceData.priceUsd;
                trade.lastUpdateTime = new Date();
                const currentValSol = trade.simulatedTokenAmount * trade.currentPrice;
                const currentValUsd = trade.simulatedTokenAmount * trade.currentPriceUsd;

                trade.profitLossSol = currentValSol - trade.simulatedSolSpent;
                trade.profitLossUsd = currentValUsd - trade.simulatedUsdSpent;
                trade.profitLossPercent = (trade.profitLossSol / trade.simulatedSolSpent) * 100;

                if (trade.profitLossPercent >= TAKE_PROFIT_PERCENT) {
                    trade.status = 'CLOSED';
                    trade.exitReason = `TP Hit (+${trade.profitLossPercent.toFixed(2)}%)`;
                    closedTrades.push(trade);
                }
            }
        });
        activeTrades = activeTrades.filter(t => t.status === 'ACTIVE');

        displayTradeStatus();

    }, PRICE_CHECK_INTERVAL_MS);
}


async function handleMigrationWssData(data: WebSocket.Data, connection: Connection): Promise<boolean> {
    if (activeTrades.length >= MAX_POSITIONS) {
        return false;
    }

    const jsonString = data.toString();
    const parsedData = JSON.parse(jsonString);

    if (parsedData.result !== undefined && !parsedData.error) {
        console.log("✅ Migration detection active.");
        return false;
    }

    const logMessages = parsedData?.params?.result?.value?.logs;
    const signature = parsedData?.params?.result?.value?.signature;

    if (!Array.isArray(logMessages) || !signature) return false;

    const hasLogMatch = PROGRAM_META_LOGS.some((metaLog) => logMessages.some((log: string) => log.includes(metaLog)));

    if (!hasLogMatch) return false;

    if (isInitializing) return false;
    isInitializing = true;

    console.log(`\n🔎 New migration detected: ${signature}`);

    try {
        const tx = await getTransactionWithRetry(connection, signature, 3);

        if (!tx?.meta) {
            console.log("❌ Failed to fetch transaction details.");
            isInitializing = false;
            return false;
        }

        const tokenBalances = tx.meta.postTokenBalances || [];
        const significantTokens = tokenBalances.filter((balance) => balance.mint !== WSOL && balance.uiTokenAmount.decimals !== 0);

        if (significantTokens.length > 0) {
            const firstToken = significantTokens[0];
            const tokenMint = firstToken.mint;

            if (activeTrades.some(t => t.tokenMint === tokenMint)) {
                console.log("⚠️ Token already active. Skipping.");
                isInitializing = false;
                return false;
            }

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
            console.log(`📉 Entry Price: ${formatPriceSol(initialPriceSol)} SOL`);
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

            const simStart = Date.now();
            (async () => {
                try {
                    let poolAddr: string | null = null;

                    const accountKeys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey);
                    console.log(`🧪 Extracting Pool Address from ${accountKeys.length} keys...`);
                    poolAddr = await extractPoolAddressFromTxKeys(connection, accountKeys);

                    if (!poolAddr) {
                        console.log("⚠️ Could not find pool in TX. Falling back to derivation.");
                        poolAddr = getComputedPoolAddress(tokenMint, WSOL);
                    }

                    if (!poolAddr) {
                        console.log("❌ Failed to identify Pool Address. Skipping Simulation.");
                        return;
                    }

                    console.log(`🧪 Simulating Fast Swap on Pool: ${poolAddr}`);

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

async function startPaperTrading(): Promise<void> {
    if (!WSS_ENDPOINT || !RPC_ENDPOINT) {
        console.log("❌ Missing WSS or RPC endpoint.");
        return;
    }
    const connection = new Connection(RPC_ENDPOINT, "confirmed");

    const keepers = config.migration_keepers;

    console.log("\n" + "=".repeat(80));
    console.log("🎮 PAPER TRADING MODE (JUPITER API EDITION)");
    console.log("=".repeat(80));
    console.log(`💰 Simulated investment per trade: ${PAPER_TRADE_AMOUNT_SOL} SOL`);
    console.log(`👀 Monitoring ${keepers.length} migration keepers:`);
    keepers.forEach((k, i) => console.log(`   Keeper ${i + 1}: ${k}`));
    console.log(`🎯 Waiting for first token migration...`);
    console.log("=".repeat(80) + "\n");

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
            ws.send(JSON.stringify(subscribeRequest));
        });

        ws.on("message", (data) => handleMigrationWssData(data, connection));

        ws.on("close", () => {
            console.log(`🔐 Keeper ${index + 1} WebSocket closed. Reconnecting in 5 seconds...`);
            setTimeout(() => startPaperTrading(), 5000);
        });

        ws.on("error", (error: Error) => {
            console.log(`❌ Keeper ${index + 1} WebSocket error:`, error.message);
        });
    });
}
startPaperTrading();
