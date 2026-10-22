import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleInterface, WalletNetwork } from "@creit.tech/stellar-wallets-kit";
import { createWalletModules } from "@/lib/wallet-modules";

const { bridge } = vi.hoisted(() => ({ bridge: vi.fn() }));
vi.mock("@creit.tech/stellar-wallets-kit/modules/walletconnect.module", () => ({
  WalletConnectModule: bridge,
  WalletConnectAllowedMethods: { SIGN: "stellar_signXDR" },
}));

const network = "Test SDF Network ; September 2015" as WalletNetwork;
const appUrl = "https://mmm-pay.github.io/payflow-frontend/";

describe("wallet module registration", () => {
  beforeEach(() => {
    bridge.mockReset();
    bridge.mockImplementation(() => ({ productId: "wallet_connect" }));
  });

  it("preserves every default wallet without requiring backend or bridge configuration", async () => {
    const defaults = ["freighter", "xbull", "albedo", "lobstr", "hana", "rabet"]
      .map((productId) => ({ productId })) as ModuleInterface[];
    expect(await createWalletModules(() => defaults, { network, appUrl })).toBe(defaults);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("adds the configured bridge once, using sign-only and the static site's URL", async () => {
    const defaults = [{ productId: "freighter" }] as ModuleInterface[];
    const modules = await createWalletModules(() => defaults, {
      network, appUrl, projectId: "  public-project-id  ",
    });
    expect(modules.map((module) => module.productId)).toEqual(["freighter", "wallet_connect"]);
    expect(defaults).toHaveLength(1);
    expect(bridge).toHaveBeenCalledOnce();
    expect(bridge).toHaveBeenCalledWith({
      projectId: "public-project-id", network, name: "Payflow",
      description: "Recurring payments on Stellar", url: appUrl, icons: [],
      method: "stellar_signXDR",
    });
  });

  it("does not enable a bridge for a blank project ID or unsupported custom network", async () => {
    const defaults = [] as ModuleInterface[];
    await createWalletModules(() => defaults, { network, appUrl, projectId: "  " });
    await createWalletModules(() => defaults, {
      network: "Custom Stellar Network" as WalletNetwork, appUrl, projectId: "configured",
    });
    expect(bridge).not.toHaveBeenCalled();
  });
});
