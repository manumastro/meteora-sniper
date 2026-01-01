import { NewTokenRecord, TokenRecord } from "../types";

export async function insertNewToken(token: NewTokenRecord): Promise<void> {
  // Stub implementation
  console.log(`[DB Stub] Inserting new token: ${token.name} (${token.mint})`);
  return Promise.resolve();
}

export async function selectTokenByNameAndCreator(name: string, creator: string): Promise<TokenRecord[]> {
  // Stub implementation
  console.log(`[DB Stub] Checking duplicate token: ${name} by ${creator}`);
  return Promise.resolve([]);
}
