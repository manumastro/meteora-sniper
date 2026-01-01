export interface RugResponseExtended {
  creator: string;
  token: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    isInitialized: boolean;
  };
  tokenMeta: {
    name: string;
    symbol: string;
    mutable: boolean;
  };
  topHolders: {
    address: string;
    pct: number;
    insider: boolean;
  }[];
  markets?: {
    liquidityA?: string;
    liquidityB?: string;
  }[];
  totalLPProviders: number;
  totalMarketLiquidity: number;
  rugged: boolean;
  score: number;
  risks?: {
    name: string;
    value: string;
    description: string;
    score: number;
    level: string;
  }[];
}

export interface NewTokenRecord {
  time: number;
  mint: string;
  name: string;
  creator: string;
}

export type TokenRecord = NewTokenRecord;
