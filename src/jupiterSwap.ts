import { Connection, Keypair, VersionedTransaction, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

const JUP_API = "https://quote-api.jup.ag/v6";

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

        // 2. Get Swap Transaction
        const swapResponse = await axios.post(`${JUP_API}/swap`, {
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true, // Auto unwrap WSOL to SOL
            prioritizationFeeLamports: "auto", // Jupiter handles priority fees
            dynamicComputeUnitLimit: true
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

        // 4. Send via Jito (Failover)
        const BLOCK_ENGINE_URLS = Array.from(jitoClients.keys());
        let bundleId = null;

        for (const engineUrl of BLOCK_ENGINE_URLS) {
            try {
                // @ts-ignore
                const searcher = jitoClients.get(engineUrl);
                
                // Bundling Jupiter Swap + Jito Tip
                const bundle = new Bundle([jupTransaction, tipVersionedTx], 5);
                const result = await searcher.sendBundle(bundle);

                if (result) {
                    // Jito-ts types are messy, checking valid response
                    // @ts-ignore
                    bundleId = result.value || result; 
                    console.log(`✅ Jupiter Sell sent via ${engineUrl}: ${bundleId}`);
                    break;
                }
            } catch (e) {
                console.log(`   Jupiter/Jito Failed via ${engineUrl}. Trying next...`);
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
