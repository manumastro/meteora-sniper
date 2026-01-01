import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { executeJupiterSell } from "../jupiterSwap";
import { executeJitoSwap } from "../execution";
import { config } from "../config";

export enum SellStrategy {
  JUPITER = "JUPITER",
  JITO = "JITO",
}

export class SellService {
  /**
   * Main entry point to sell tokens.
   * Defaults to Jupiter as it's the general purpose solution.
   */
  static async executeSell(
    connection: Connection,
    walletKeypair: Keypair,
    mint: string,
    amount: number, // Token Amount (Integer)
    poolAddress: string | null, // Required only for Jito
    strategy: SellStrategy = SellStrategy.JUPITER,
    jitoClients?: Map<string, any>, // Required for Jupiter (passed deeply) or Jito
    jitoClient?: any, // Specific client for Jito
    tipAccounts: string[] = []
  ): Promise<string | null> {
    
    if (tipAccounts.length === 0) {
        console.error("❌ No tip accounts available for sell.");
        return null;
    }

    // Common params
    const tipLamports = 0.0001 * 1_000_000_000; // Hardcoded or from config
    const randomTipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);

    console.log(`📉 Selling ${amount} of ${mint} using ${strategy}...`);

    try {
        if (strategy === SellStrategy.JUPITER) {
            if (!jitoClients) {
                console.error("❌ Jito Clients map required for Jupiter Sell.");
                return null;
            }
            return await executeJupiterSell(
                connection,
                jitoClients,
                walletKeypair,
                mint,
                amount,
                tipLamports,
                randomTipAccount.toBase58() // Expects string
            );
        } else if (strategy === SellStrategy.JITO) {
            if (!poolAddress || !jitoClient) {
                console.error("❌ Pool Address and Jito Client required for Jito Sell.");
                return null;
            }
            // Logic moved from triggerSell
            return await executeJitoSwap(
                jitoClient,
                connection,
                walletKeypair,
                poolAddress,
                mint,
                amount,
                tipLamports,
                randomTipAccount, // Expects PublicKey
                5.0 // High slippage for forced exit
            );
        }
    } catch (e) {
        console.error("❌ Sell Execution Failed:", e);
    }

    return null;
  }
}
