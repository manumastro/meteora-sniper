export const config = {
  program: {
    id: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora DBC Program
    meta_logs: ["Program log: Instruction: MigrationDammV2"],
    instruction: [[0x9c, 0xa9, 0xe6, 0x67, 0x35, 0xe4, 0x50, 0x40]], // migration_damm_v2 discriminator
    mint_index: 13,
  },
  migration_keepers: [
    "DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW", // Migration Keeper 2
    "CQdrEsYAxRqkwmpycuTwnMKggr3cr9fqY8Qma4J9TudY", // Migration Keeper 1
  ],
  wsol_pc_mint: "So11111111111111111111111111111111111111112",
  dry_run: false, // Set to false to enable real trading
  axios: {
    get_timeout: 5000,
  },
  sell: {
    auto_sell_delay_ms: 30000, // 30 seconds
  },
  checks: {
    verbose_logs: false,
    settings: {
      exclude_lp_from_topholders: true,
      allow_mint_authority: false,
      allow_not_initialized: false,
      allow_freeze_authority: false,
      allow_mutable: true, // Often true for new tokens, set to true to be less strict or false to be strict
      allow_insider_topholders: false,
      max_alowed_pct_topholders: 50, // Example value
      min_total_lp_providers: 0, // Set low for new tokens
      min_total_markets: 0, // Set low for new tokens
      min_total_market_Liquidity: 0, // Set low for new tokens
      allow_rugged: false,
      block_symbols: ["SCAM"],
      block_names: ["Rug"],
      max_score: 1000, // Strict score
      ignore_ends_with_pump: true,
      block_returning_token_names: true,
      block_returning_token_creators: true,
    }
  }
};

