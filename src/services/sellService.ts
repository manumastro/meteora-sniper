import { Connection, Keypair } from "@solana/web3.js";
import { executeDBCSwap } from "../execution";
import { config } from "../config";

export enum SellStrategy {
  DBC_RPC = "DBC_RPC",
}

export class SellService {
  static async executeSell(
    connection: Connection,
    walletKeypair: Keypair,
    mint: string,
    amount: number,
    poolAddress: string,
    priorityFeeMicroLamports: number = 100000 // Default 100k, can escalate on retries
  ): Promise<{ signature: string | null; error?: string }> {
    
    if (!poolAddress) {
        console.error("❌ Pool Address required for DBC Sell.");
        return { signature: null, error: "MissingPoolAddress" };
    }
    console.log(`📉 Selling ${amount} of ${mint} using DBC Direct...`);

    try {
        // Use executeDBCSwap for selling
        // Token In: The Token (Mint)
        // Token Out: WSOL
        const wsol = config.wsol_pc_mint || "So11111111111111111111111111111111111111112";

        // IMPORTANT: DBC SDK requires integer amounts (lamports/atomic units)
        // Ensure amount is passed as integer
        const amountInt = Math.floor(amount);

        const result = await executeDBCSwap(
            connection,
            walletKeypair,
            poolAddress,
            mint,     // Selling Token (Token In)
            wsol,     // Buying WSOL (Token Out)
            amountInt,// Amount of Token to sell
            50.0,     // High slippage for sell
            true,     // Close Token Account to reclaim rent
            priorityFeeMicroLamports // Pass priority fee
        );
        return result;

    } catch (e: any) {
        console.error(`❌ Sell failed:`, e);
        return { signature: null, error: e?.message || "UnknownSellError" };
    }
  }
}
