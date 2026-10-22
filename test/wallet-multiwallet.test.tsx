// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { WalletProvider, setKitPromiseForTesting, useWallet } from "@/lib/wallet";

const networkPassphrase = "Test SDF Network ; September 2015";
const address = "GAEWDXVDI3WI35TWTZXNQ4NTRYIG6J34XPRSNKX655LBA377M5ZOCBY5";

afterEach(() => {
  cleanup();
  localStorage.clear();
  setKitPromiseForTesting(null);
});

describe("wallet-independent connection and signing delegation", () => {
  it.each(["xbull", "albedo", "lobstr", "hana"])("connects and signs through %s", async (walletId) => {
    const kit = {
      setWallet: vi.fn(),
      getAddress: vi.fn(async () => ({ address })),
      getNetwork: vi.fn(async () => ({ networkPassphrase })),
      signTransaction: vi.fn(async () => ({ signedTxXdr: "SIGNED_TEST_XDR" })),
      openModal: vi.fn(async (options: { onWalletSelected: (wallet: { id: string }) => Promise<void> }) => {
        await options.onWalletSelected({ id: walletId });
      }),
    };
    setKitPromiseForTesting(Promise.resolve(kit as unknown as StellarWalletsKit));
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => result.current.connect());
    expect(kit.setWallet).toHaveBeenCalledWith(walletId);
    expect(result.current.address).toBe(address);
    await expect(result.current.signXdr("UNSIGNED_TEST_XDR")).resolves.toBe("SIGNED_TEST_XDR");
    expect(kit.signTransaction).toHaveBeenCalledWith("UNSIGNED_TEST_XDR", {
      address, networkPassphrase,
    });
  });
});
