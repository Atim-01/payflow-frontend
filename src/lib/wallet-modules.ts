import type { ModuleInterface, WalletNetwork } from "@creit.tech/stellar-wallets-kit";

interface WalletModuleOptions {
  projectId?: string;
  network: WalletNetwork;
  appUrl: string;
}

/** Called only by the browser-side kit factory; importing this file is SSR-safe. */
export async function createWalletModules(
  defaultModules: () => ModuleInterface[],
  options: WalletModuleOptions,
): Promise<ModuleInterface[]> {
  // Includes xBull, Albedo, Lobstr and Hana, plus the existing default wallets.
  const modules = defaultModules();
  const projectId = options.projectId?.trim();
  if (!projectId) return modules;
  // The kit's WalletConnect bridge supports these two Stellar namespaces only.
  if (options.network !== "Test SDF Network ; September 2015" &&
      options.network !== "Public Global Stellar Network ; September 2015") return modules;

  const { WalletConnectModule, WalletConnectAllowedMethods } = await import(
    "@creit.tech/stellar-wallets-kit/modules/walletconnect.module"
  );
  return [
    ...modules,
    new WalletConnectModule({
      projectId,
      network: options.network,
      name: "Payflow",
      description: "Recurring payments on Stellar",
      url: options.appUrl,
      icons: [],
      // Submission remains in Payflow's RPC path, never delegated to the wallet.
      method: WalletConnectAllowedMethods.SIGN,
    }),
  ];
}
