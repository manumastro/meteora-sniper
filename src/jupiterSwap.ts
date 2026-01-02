import { Connection, Keypair, VersionedTransaction, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

const JUP_API = "https://lite-api.jup.ag/swap/v1"; // Public Lite API (No Key required)

export async function executeJupiterSell(
    connection: Connection,
    jitoClients: Map<string, any>,
    wallet: Keypair,
    tokenMint: string,
    amount: number,
    tipLamports: number,
    tipAccount: string
): Promise<string | null> {
    try {
        console.log(`🪐 Jupiter: Fetching Sell Quote for ${amount} tokens...`);

        // 1. Get Quote (Input: Token, Output: SOL)
        // WSOL Mint: So11111111111111111111111111111111111111112
        const quoteUrl = `${JUP_API}/quote?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=200`; // 2% slippage default
        const quoteResponse = await axios.get(quoteUrl);
        const quoteData = quoteResponse.data;

        if (!quoteData || quoteData.error) {
            console.error("❌ Jupiter Quote Failed:", quoteData?.error || "No data");
            return null;
        }

        console.log(`   Quote: ${quoteData.inAmount} -> ${quoteData.outAmount} SOL`);
        console.log(`   🪐 Requesting Swap Transaction from Jupiter...`);

        // 2. Get Swap Transaction
        const swapResponse = await axios.post(`${JUP_API}/swap`, {
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true, // Auto unwrap WSOL to SOL
            prioritizationFeeLamports: "auto", // Jupiter handles priority fees
            dynamicComputeUnitLimit: true,
            skipUserAccountsRpcCalls: true // Optimization
        });

        const swapTransactionBase64 = swapResponse.data.swapTransaction;
        
        // 3. Deserialize and Sign Jupiter TX
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const jupTransaction = VersionedTransaction.deserialize(swapTransactionBuf);
        jupTransaction.sign([wallet]);

        // 3b. Create Tip Transaction (Legacy)
        const tipInst = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(tipAccount.trim()),
            lamports: tipLamports,
        });
        const tipTransaction = new Transaction().add(tipInst);
        const { blockhash } = await connection.getLatestBlockhash();
        tipTransaction.recentBlockhash = blockhash;
        tipTransaction.feePayer = wallet.publicKey;
        tipTransaction.sign(wallet);
        
        const tipVersionedTx = new VersionedTransaction(tipTransaction.compileMessage());
        tipVersionedTx.sign([wallet]);

        // 4. Send via Jito (Primary)
        console.log(`   📦 Sending via Jito...`);
        const BLOCK_ENGINE_URLS = Array.from(jitoClients.keys());
        let bundleId = null;

        for (const engineUrl of BLOCK_ENGINE_URLS) {
            try {
                // @ts-ignore
                const searcher = jitoClients.get(engineUrl);
                
                // Bundling Jupiter Swap + Jito Tip
                const bundle = new Bundle([jupTransaction, tipVersionedTx], 5);
                
                // Add Timeout to prevent hanging
                const result = await Promise.race([
                    searcher.sendBundle(bundle),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Jito Timeout")), 5000))
                ]);

                if (result) {
                    // Jito-ts types are messy, checking valid response
                    // @ts-ignore
                    bundleId = result.value || result; 
                    console.log(`✅ Jupiter Sell sent via ${engineUrl}: ${bundleId}`);
                    // Return immediately if Jito succeeds
                    return bundleId;
                }
            } catch (e) {
                console.log(`   Jupiter/Jito Failed via ${engineUrl}. Trying next...`);
            }
        }

        // 5. RPC Fallback (If Jito Failed)
        if (!bundleId) {
            console.log("⚠️ Jito failed or no engines. Attempting Direct RPC...");
            try {
                // Send standard Jupiter TX (Without tip arg usually, but Jup TX is signed)
                // Note: Jup TX already includes priority fees from API
                const rawTransaction = jupTransaction.serialize();
                const txid = await connection.sendRawTransaction(rawTransaction, {
                    skipPreflight: true,
                    maxRetries: 2
                });
                console.log(`✅ Jupiter Sell sent via RPC: ${txid}`);
                return txid;
            } catch (rpcError: any) {
                 console.error("❌ RPC Fallback Failed:", rpcError.message);
                 return null;
            }
        }

        return bundleId;

    } catch (e: any) {
        console.error("❌ Jupiter Sell Failed:", e.message);
        if (e.response) {
            console.error("   API Error:", e.response.data);
        }
        return null;
    }
}

export async function executeJupiterBuy(
    connection: Connection,
    jitoClients: Map<string, any>,
    wallet: Keypair,
    tokenMint: string,
    solAmount: number, // Amount in SOL (e.g., 0.1)
    tipLamports: number,
    tipAccount: string
): Promise<string | null> {
    try {
        console.log(`🪐 Jupiter: Fetching Buy Quote for ${solAmount} SOL -> ${tokenMint}...`);

        const inputMint = "So11111111111111111111111111111111111111112"; // WSOL
        const outputMint = tokenMint;
        const amountLamports = Math.floor(solAmount * 1_000_000_000);

        // 1. Get Quote with Retry
        const quoteUrl = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=300`; // 3% slippage
        
        let quoteData = null;
        for (let i = 0; i < 20; i++) { // Aggressive Retries (User Request)
            try {
                const quoteResponse = await axios.get(quoteUrl, { timeout: 5000 });
                if (quoteResponse.data && !quoteResponse.data.error) {
                    quoteData = quoteResponse.data;
                    break;
                }
            } catch (e: any) {
                console.log(`   ⚠️ Jupiter Quote Attempt ${i + 1}/20 failed: ${e.message}. Retrying...`);
                await new Promise(r => setTimeout(r, 500)); // Faster retries (500ms)
            }
        }

        if (!quoteData) {
            console.error("❌ Jupiter Quote Failed after 20 attempts.");
            return null;
        }

        console.log(`   Quote: ${quoteData.inAmount} Lamports -> ${quoteData.outAmount} Tokens`);

        // 2. Get Swap Transaction
        const swapResponse = await axios.post(`${JUP_API}/swap`, {
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: "auto",
            dynamicComputeUnitLimit: true,
            skipUserAccountsRpcCalls: true // Optimization from user snippet
        });

        const swapTransactionBase64 = swapResponse.data.swapTransaction;
        
        // 3. Deserialize and Sign Jupiter TX
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const jupTransaction = VersionedTransaction.deserialize(swapTransactionBuf);
        jupTransaction.sign([wallet]);

        // 3b. Create Tip Transaction
        const tipInst = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(tipAccount.trim()),
            lamports: tipLamports,
        });
        const tipTransaction = new Transaction().add(tipInst);
        const { blockhash } = await connection.getLatestBlockhash();
        tipTransaction.recentBlockhash = blockhash;
        tipTransaction.feePayer = wallet.publicKey;
        tipTransaction.sign(wallet);
        
        const tipVersionedTx = new VersionedTransaction(tipTransaction.compileMessage());
        tipVersionedTx.sign([wallet]);

        // 4. Send via Jito (Failover)
        const BLOCK_ENGINE_URLS = Array.from(jitoClients.keys());
        let bundleId = null;

        for (const engineUrl of BLOCK_ENGINE_URLS) {
            try {
                // @ts-ignore
                const searcher = jitoClients.get(engineUrl);
                
                const bundle = new Bundle([jupTransaction, tipVersionedTx], 5);
                const result = await searcher.sendBundle(bundle);

                if (result) {
                    // @ts-ignore
                    bundleId = result.value || result; 
                    console.log(`✅ Jupiter Buy sent via ${engineUrl}: ${bundleId}`);
                    
                    // Return immediately on success? Or wait? 
                    // Usually we break and return bundleId.
                    // The caller handles confirmation.
                    break;
                }
            } catch (e) {
                console.log(`   Jupiter/Jito Failed via ${engineUrl}. Trying next...`);
            }
        }

        if (!bundleId) return null;

        // Extract transaction signature for confirmation (Bundle ID != Transaction Signature)
        // jupTransaction.signatures[0] is a Uint8Array, need to convert to base58 string
        const txSignature = bs58.encode(Buffer.from(jupTransaction.signatures[0]));
        console.log(`📝 Transaction Signature: ${txSignature}`);
        
        return txSignature;

    } catch (e: any) {
        console.error("❌ Jupiter Buy Failed:", e.message);
        if (e.response) {
             // Often "Route not found" for new tokens
            console.error("   API Error:", e.response.data);
        }
        return null;
    }
}
