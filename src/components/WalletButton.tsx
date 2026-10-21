"use client";

import { useI18n } from "@/i18n/provider";

import { useWallet } from "@/lib/wallet";
import { shortAddress } from "@/lib/format";

export function WalletButton() {
  const { t: tr } = useI18n();
  const { address, connecting, connect, disconnect } = useWallet();

  if (address) {
    return (
      <button
        type="button"
        onClick={() => void disconnect()}
        className="btn-ghost mono"
        title={tr("{0} — click to disconnect", { "0": address })}
      >
        <span className="h-2 w-2 rounded-full bg-accent" />
        {shortAddress(address, 5)}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void connect()}
      disabled={connecting}
      className="btn-primary"
    >
      {connecting ?tr("Connecting…") :tr("Connect wallet")}
    </button>
  );
}
