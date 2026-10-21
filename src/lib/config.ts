/**
 * Every value here is inlined at build time. Changing an env var on the host
 * requires a rebuild, not just a restart — this is the usual cause of a
 * deployed frontend still calling localhost.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and set it, then rebuild.`,
    );
  }
  return value;
}

export interface ClassicAsset {
  code: string;
  issuer: string;
}

export interface ConfiguredToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  classicAsset?: ClassicAsset;
}

const DEFAULT_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const DEFAULT_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export const XLM_TOKEN: ConfiguredToken = {
  id: process.env.NEXT_PUBLIC_TOKEN_ID || DEFAULT_XLM_SAC,
  symbol: "XLM",
  name: "Stellar Lumens",
  decimals: 7,
};

export const USDC_TESTNET_TOKEN: ConfiguredToken = {
  id: process.env.NEXT_PUBLIC_USDC_TOKEN_ID || DEFAULT_USDC_SAC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  classicAsset: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
};

export const CONFIGURED_TOKENS: readonly ConfiguredToken[] = [
  XLM_TOKEN,
  USDC_TESTNET_TOKEN,
];

export const config = {
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  rpcUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
  /** Horizon serves account `home_domain`s (stellar.toml names); RPC does not. */
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  networkPassphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  network: process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET",
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",
  /**
   * Source account used for read-only contract simulation before a wallet is
   * connected. Simulation never touches this account — it only has to exist on
   * the network. Defaults to the deployer of the public testnet suite.
   */
  readSource:
    process.env.NEXT_PUBLIC_READ_SOURCE ??
    "GAKOHW5FUKSF3SXQQWLD647RQJPOR5RZOS4ITSMWC5NPC67DEXXYU43H",
  contracts: {
    planRegistry: process.env.NEXT_PUBLIC_PLAN_REGISTRY_ID ?? "",
    vault: process.env.NEXT_PUBLIC_VAULT_ID ?? "",
    subscription: process.env.NEXT_PUBLIC_SUBSCRIPTION_ID ?? "",
    token: process.env.NEXT_PUBLIC_TOKEN_ID ?? "",
    usdc: process.env.NEXT_PUBLIC_USDC_TOKEN_ID ?? USDC_TESTNET_TOKEN.id,
  },
  tokens: CONFIGURED_TOKENS,
} as const;

export function requireContracts(): void {
  required("NEXT_PUBLIC_PLAN_REGISTRY_ID", config.contracts.planRegistry);
  required("NEXT_PUBLIC_VAULT_ID", config.contracts.vault);
  required("NEXT_PUBLIC_SUBSCRIPTION_ID", config.contracts.subscription);
}

export const explorerBase = "https://stellar.expert/explorer/testnet";
