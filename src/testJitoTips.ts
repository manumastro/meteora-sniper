
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { PublicKey, Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

const BLOCK_ENGINE_URL = "frankfurt.mainnet.block-engine.jito.wtf"; // Force one
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY;

async function testTips() {
    console.log("🧪 Testing Jito Tip Accounts...");
    
    if (!PRIVATE_KEY_B58) {
        console.error("❌ No PRIVATE_KEY");
        return;
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
    const connection = new Connection("https://api.mainnet-beta.solana.com"); // Use public RPC for test to isolate
    const client = searcherClient(BLOCK_ENGINE_URL, keypair);

    // 1. Fetch Tips
    try {
        console.log("⏳ Fetching Tip Accounts...");
        const tips = await client.getTipAccounts();
        console.log("✅ Fetched Tips:", tips);
    } catch (e) {
        console.error("❌ Failed to fetch tips:", e);
    }

    // 2. Try to Send a Bundle with Hardcoded Tip
    const tipAccount = new PublicKey("DfXygSm4jCyNCyb3qzK69cz12ueHD5yJiG1hR5tJQr9B");
    
    console.log(`\n🚀 Building Test Bundle with Tip Account: ${tipAccount.toBase58()}`);
    
    const tipIx = SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: tipAccount,
        lamports: 100000, // 0.0001 SOL
    });

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    
    const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [tipIx], // JUST the tip
    }).compileToV0Message();

    const vTx = new VersionedTransaction(messageV0);
    vTx.sign([keypair]);

    const bundle = new Bundle([vTx], 5);

    try {
        console.log("⚡ Sending Test Bundle...");
        const result = await client.sendBundle(bundle);
        console.log("✅ Result:", result);
    } catch (e: any) {
        console.log("❌ Bundle Error:", e);
    }
}

testTips();
