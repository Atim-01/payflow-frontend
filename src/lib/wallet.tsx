"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { config } from "./config";
import { createWalletModules } from "./wallet-modules";
import type { SignXdr } from "./payflow";
import { translateSignatureError } from "./signature-error";

export const STORAGE_KEY = "payflow.wallet";
export const ACCOUNT_CHANGED_ERROR =
  "Wallet account changed. Please retry the transaction with the new account.";

export interface StoredSession {
  walletId: string;
  address: string;
}

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.walletId === "string" && typeof parsed?.address === "string") {
      return { walletId: parsed.walletId, address: parsed.address };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeSession(walletId: string, address: string): string {
  return JSON.stringify({ walletId, address });
}

export function updateStoredSessionAddress(
  raw: string | null,
  newAddress: string,
): string | null {
  const session = parseStoredSession(raw);
  if (!session) return null;
  return serializeSession(session.walletId, newAddress);
}

export function checkNetworkMismatch(
  walletNetwork: string | null,
  targetPassphrase = config.networkPassphrase,
): boolean {
  if (!walletNetwork) return false;
  return walletNetwork !== targetPassphrase;
}

export function shouldUpdateAddress(
  currentAddress: string | null,
  detectedAddress: string | null | undefined,
): boolean {
  if (!currentAddress || !detectedAddress) return false;
  return currentAddress !== detectedAddress;
}

export interface WalletState {
  address: string | null;
  connecting: boolean;
  error: string | null;
  networkMismatch: boolean;
  walletNetwork: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signXdr: SignXdr;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * The kit registers browser custom elements on construction, so it is imported
 * dynamically and only ever instantiated client-side. Building it at module
 * scope breaks the Next.js server render.
 */
let kitPromise: Promise<StellarWalletsKit> | null = null;

export async function getKit(): Promise<StellarWalletsKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const mod = await import("@creit.tech/stellar-wallets-kit");
      const network = config.networkPassphrase as (typeof mod.WalletNetwork)[keyof typeof mod.WalletNetwork];
      const modules = await createWalletModules(mod.allowAllModules, {
        projectId: config.walletConnectProjectId,
        network,
        appUrl: `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`,
      });
      return new mod.StellarWalletsKit({ network, modules });
    })();
  }
  return kitPromise;
}

/**
 * Injects a kit instance for testing.
 */
export function setKitPromiseForTesting(p: Promise<StellarWalletsKit> | null) {
  kitPromise = p;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);

  // Keep a ref of the current address to avoid stale closures in event listeners
  // and async callbacks. Every setter below already writes the ref alongside the
  // state, so this effect only keeps them in step for addresses that reach the
  // state some other way. Refs are not written during render (react-hooks/refs).
  const addressRef = useRef<string | null>(address);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  // Track in-flight checks to prevent duplicate concurrent queries.
  const syncingRef = useRef(false);

  const networkMismatch = useMemo(
    () => checkNetworkMismatch(walletNetwork),
    [walletNetwork],
  );

  const applyAccountChange = useCallback((newAddress: string) => {
    addressRef.current = newAddress;
    setAddress(newAddress);
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const updated = updateStoredSessionAddress(stored, newAddress);
    if (updated) {
      window.localStorage.setItem(STORAGE_KEY, updated);
    }
    // Re-check network mismatch for the new account
    void getKit().then(async (kit) => {
      try {
        const { networkPassphrase } = await kit.getNetwork();
        setWalletNetwork(networkPassphrase);
      } catch {
        setWalletNetwork(null);
      }
    });
  }, []);

  const checkAccount = useCallback(async () => {
    if (!addressRef.current || syncingRef.current) return;
    syncingRef.current = true;
    try {
      const kit = await getKit();
      const { address: detected } = await kit.getAddress();
      if (shouldUpdateAddress(addressRef.current, detected)) {
        applyAccountChange(detected);
      }
    } catch {
      // Wallet extension may be closed, locked, or busy; ignore background errors
    } finally {
      syncingRef.current = false;
    }
  }, [applyAccountChange]);

  // Restore the previous session without prompting the user again.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const session = parseStoredSession(stored);
    if (!session) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const { walletId, address: saved } = session;
    void getKit().then(async (kit) => {
      kit.setWallet(walletId);
      let activeAddress = saved;
      try {
        const { address: detected } = await kit.getAddress();
        if (detected) {
          activeAddress = detected;
          if (detected !== saved) {
            window.localStorage.setItem(
              STORAGE_KEY,
              serializeSession(walletId, detected),
            );
          }
        }
      } catch {
        // Wallet may be locked or not ready; keep saved
      }
      addressRef.current = activeAddress;
      setAddress(activeAddress);
      // Restore the network mismatch state for the restored session
      try {
        const { networkPassphrase } = await kit.getNetwork();
        setWalletNetwork(networkPassphrase);
      } catch {
        // Wallet may not support getNetwork; treat as no mismatch
        setWalletNetwork(null);
      }
    });
  }, []);

  // Re-read address on window focus or document visibility change. If the user
  // switched accounts in the wallet extension popup and returned to this tab,
  // update state and storage.
  useEffect(() => {
    if (!address) return;

    function onFocus() {
      void checkAccount();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void checkAccount();
      }
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [address, checkAccount]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const kit = await getKit();
      await kit.openModal({
        onWalletSelected: async (option) => {
          try {
            kit.setWallet(option.id);
            const { address: selected } = await kit.getAddress();
            addressRef.current = selected;
            setAddress(selected);
            // Detect network mismatch after connection
            try {
              const { networkPassphrase } = await kit.getNetwork();
              setWalletNetwork(networkPassphrase);
            } catch {
              setWalletNetwork(null);
            }
            window.localStorage.setItem(
              STORAGE_KEY,
              serializeSession(option.id, selected),
            );
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not read address");
            setWalletNetwork(null);
          } finally {
            setConnecting(false);
          }
        },
        onClosed: () => setConnecting(false),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open wallet");
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const kit = await getKit();
    try {
      await kit.disconnect();
    } catch {
      // Some wallets have no disconnect concept; clearing local state is enough.
    }
    window.localStorage.removeItem(STORAGE_KEY);
    addressRef.current = null;
    setAddress(null);
    setWalletNetwork(null);
  }, []);

  const signXdr = useCallback<SignXdr>(
    async (xdrString) => {
      if (!address) throw new Error("Connect a wallet first.");
      if (networkMismatch) throw new Error("Switch your wallet to the correct network first.");
      const kit = await getKit();

      // Re-read the address before signing. If the user switched accounts
      // in the wallet extension popup, the prepared transaction was built
      // for the previous address. Signing it would fail verification or act
      // on the wrong account.
      let currentAddress: string | null = null;
      try {
        const res = await kit.getAddress();
        currentAddress = res.address;
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Could not read address from wallet.",
        );
      }

      if (shouldUpdateAddress(address, currentAddress)) {
        applyAccountChange(currentAddress!);
        throw new Error(ACCOUNT_CHANGED_ERROR);
      }

      try {
        const { signedTxXdr } = await kit.signTransaction(xdrString, {
          networkPassphrase: config.networkPassphrase,
          address,
        });
        return signedTxXdr;
      } catch (err) {
        translateSignatureError(err);
      }
    },
    [address, networkMismatch, applyAccountChange],
  );

  const value = useMemo<WalletState>(
    () => ({ address, connecting, error, networkMismatch, walletNetwork, connect, disconnect, signXdr }),
    [address, connecting, error, networkMismatch, walletNetwork, connect, disconnect, signXdr],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside a WalletProvider");
  return ctx;
}
