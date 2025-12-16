import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Generate a new random keypair
const keypair = Keypair.generate();

console.log("\n" + "=".repeat(60));
console.log("🆕 NUOVO WALLET GENERATO PER IL BOT");
console.log("=".repeat(60));
console.log("\n1️⃣  La tua CHIAVE PRIVATA (Da mettere nel file .env):");
console.log(bs58.encode(keypair.secretKey));

console.log("\n2️⃣  Il tuo INDIRIZZO PUBBLICO (Dove mandare i SOL da Crypto.com/Bybit):");
console.log(keypair.publicKey.toBase58());

console.log("\n" + "=".repeat(60));
console.log("⚠️  SALVA LA CHIAVE PRIVATA AL SICURO!");
console.log("⚠️  NON CONDIVIDERLA CON NESSUNO.");
console.log("=".repeat(60) + "\n");
