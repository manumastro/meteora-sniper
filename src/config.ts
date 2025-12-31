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
};
