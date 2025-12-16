import dotenv from "dotenv";
import { Connection, Keypair, SystemProgram, Transaction, VersionedTransaction, TransactionMessage, PublicKey } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import bs58 from "bs58";

dotenv.config();

const RPC_ENDPOINT = process.env.SVS_UNSTAKED_RPC || "";
const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || "amsterdam.mainnet.block-engine.jito.wtf";
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY || "";
const JITO_TIP_AMOUNT_SOL = 0.001; 

// One of Jito's Tip Accounts
const TIP_ACCOUNT = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

async function testJitoBundle() {
    if (!PRIVATE_KEY_B58 || !RPC_ENDPOINT) {
        console.error("❌ Valid Config missing (.env).");
        return;
    }

    const connection = new Connection(RPC_ENDPOINT, "confirmed");
    const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
    console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);

    const client = searcherClient(JITO_BLOCK_ENGINE_URL, wallet);
    console.log(`🔌 Connected to Jito: ${JITO_BLOCK_ENGINE_URL}`);

    try {
        console.log("📦 Constructing Bundle...");
        
        const latestBlockhash = await connection.getLatestBlockhash("confirmed");

        // 1. Self Transfer (0 SOL) just to have a valid instruction
        const memoIx = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 0
        });

        // 2. Tip Instruction
        const tipIx = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: TIP_ACCOUNT,
            lamports: JITO_TIP_AMOUNT_SOL * 1_000_000_000
        });

        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [memoIx, tipIx],
        }).compileToV0Message();

        const vTx = new VersionedTransaction(messageV0);
        vTx.sign([wallet]);

        const bundle = new Bundle([vTx], 5);

        console.log("🚀 Sending Bundle...");
        const result = await client.sendBundle(bundle);

        console.log("✅ Result:", result);
        // @ts-ignore
        if (result.value) {
             // @ts-ignore
            console.log(`🔗 Explorer: https://explorer.jito.wtf/bundle/${result.value}`);
        }

    } catch (e: any) {
        console.error("❌ Bundle Failed:", e);
    }
}

testJitoBundle();
