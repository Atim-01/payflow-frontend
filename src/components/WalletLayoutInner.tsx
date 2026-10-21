"use client";

import { useI18n } from "@/i18n/provider";

import Link from "next/link";
import { LanguagePicker } from "@/i18n/LanguagePicker";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WalletButton } from "@/components/WalletButton";
import { NetworkMismatchBanner } from "@/components/ui";
import {
  APP_VERSION,
  COMMIT_HASH,
  formatCommit,
  formatVersion,
  getCommitUrl,
  getProtocolContractLinks,
  buildDebugInfo,
  formatDebugInfo,
} from "@/lib/build-info";
import { config } from "@/lib/config";
import { useWallet } from "@/lib/wallet";
import { copyToClipboard } from "@/lib/clipboard";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/subscribe", label: "Subscribe" },
  { href: "/account", label: "My account" },
  { href: "/merchant", label: "Merchant" },
];

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The visible app shell: header, nav, footer, and the global network
 * mismatch banner.
 *
 * Lives in its own file because it calls the `useWallet` hook, which only
 * works inside a client component. `src/app/layout.tsx` stays a server
 * component so it can keep exporting `metadata`.
 */
export function WalletLayoutInner({ children }: { children: React.ReactNode }) {
  const { t: tr } = useI18n();
  const { networkMismatch, walletNetwork, address } = useWallet();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);

  let walletName: string | null = null;
  try { walletName = typeof window !== "undefined" ? window.localStorage.getItem("payflow.wallet") : null; } catch { /* Storage is optional. */ }
  let walletDisplayName = "Unknown";
  if (walletName) {
    try {
      const parsed = JSON.parse(walletName);
      walletDisplayName = parsed.walletId || "Unknown";
    } catch {
      walletDisplayName = walletName;
    }
  }

  const handleCopyDebugInfo = async () => {
    const debugInfo = buildDebugInfo(
      address ? { name: walletDisplayName, address } : null,
    );
    const text = formatDebugInfo(debugInfo);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Navigate to a new page: the menu is no longer needed.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Register service worker for app shell caching in PWA mode
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      const bp = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      const swUrl = `${bp}/sw.js`;
      const scope = `${bp}/`;
      navigator.serviceWorker.register(swUrl, { scope }).catch(() => {});
    }
  }, []);

  // While open, move focus into the menu and let Escape close it. Escape
  // returns focus to the toggle so a keyboard user does not lose their place.
  useEffect(() => {
    if (!open) return;

    const firstLink = menuRef.current?.querySelector<HTMLAnchorElement>("a");
    firstLink?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const versionText = formatVersion(APP_VERSION);
  const commitShort = formatCommit(COMMIT_HASH);
  const commitUrl = getCommitUrl(commitShort);
  const contractLinks = getProtocolContractLinks();

  return (
    <>
      {networkMismatch && (
        <div className="mx-auto max-w-5xl px-5 pt-4 print:hidden">
          <NetworkMismatchBanner
            walletNetwork={walletNetwork}
            expectedNetwork={config.networkPassphrase}
          />
        </div>
      )}
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 print:block print:max-w-none print:px-0">
        {/*
          Skip-navigation link: invisible until focused via keyboard. Lets
          screen-reader and keyboard users jump straight to the page content
          without tabbing through the header on every navigation. The href
          matches the id on <main> below. A Next.js <Link> would prefetch
          the current page unnecessarily, so a plain anchor is correct here.
        */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-fg focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent"
        >{tr("Skip to content")}</a>
        <header className="border-b border-edge py-4 sm:py-5 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-6">
              <Link href="/" className="shrink-0 text-lg font-semibold tracking-tight">{tr("Pay")}<span className="text-accent">{tr("flow")}</span>
              </Link>
              <nav className="hidden gap-4 text-sm text-muted md:flex" aria-label={tr("Main navigation")}>
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                    className={`hover:text-fg ${
                      isCurrent(pathname, item.href) ? "text-fg" : ""
                    }`}
                  >
                    {tr(item.label)}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <WalletButton />
              <button
                ref={toggleRef}
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls="mobile-nav"
                aria-label={open ?tr("Close menu") :tr("Open menu")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge text-muted transition hover:border-muted hover:bg-fg/5 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
              >
                {open ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M4 7h16M4 12h16M4 17h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className="mt-3 flex justify-end"><LanguagePicker /></div>
          <nav
            id="mobile-nav"
            ref={menuRef}
            aria-label={tr("Main navigation")}
            hidden={!open}
            className="mt-3 border-t border-edge pt-3 md:hidden"
          >
            <ul className="space-y-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                    className={`block rounded-lg px-2 py-2.5 text-sm text-muted hover:bg-fg/5 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      isCurrent(pathname, item.href) ? "bg-fg/5 text-fg" : ""
                    }`}
                  >
                    {tr(item.label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <main id="main-content" className="flex-1 py-8 print:py-0">{children}</main>

        {/*
          Footer displays the build version and short commit hash (injected
          via next.config.mjs at build time) alongside explorer links for
          the three core protocol contracts. These remain visible in
          contract-only mode and before any wallet connects, making it easy
          to identify the running build when filing or reviewing bug reports.
        */}
        <footer className="border-t border-edge py-6 text-xs text-muted print:hidden">
          <div className="flex flex-col gap-3">
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
              aria-label={tr("Deployed protocol contracts")}
            >
              <span className="font-medium text-soft">{tr("Contracts:")}</span>
              {contractLinks.map((contract) => (
                <span key={contract.name} className="inline-flex items-center gap-1">
                  <span>{tr(contract.name)}:</span>
                  {contract.url ? (
                    <a
                      href={contract.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mono text-muted underline-offset-2 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      title={contract.id}
                      aria-label={tr("{0} contract on Stellar Expert: {1}", { "0": contract.name, "1": contract.id })}
                    >
                      {contract.shortId}
                    </a>
                  ) : (
                    <span className="text-muted">{tr("not configured")}</span>
                  )}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-muted">
              <span>{tr("Stellar testnet · unaudited · do not use with real funds")}</span>
              <div className="flex items-center gap-2">
                {(versionText || commitShort) && (
                  <>
                    <span>
                      {versionText}
                      {commitShort && (
                        <>
                          {versionText ? " (" : ""}
                          {commitUrl ? (
                            <a
                              href={commitUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mono underline-offset-2 hover:text-soft hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                              title={tr("Git commit {0}", { "0": commitShort })}
                              aria-label={tr("Git commit {0}", { "0": commitShort })}
                            >
                              {commitShort}
                            </a>
                          ) : (
                            <span className="mono">{commitShort}</span>
                          )}
                          {versionText ? ")" : ""}
                        </>
                      )}
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={handleCopyDebugInfo}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted border border-edge hover:bg-fg/5 hover:text-fg hover:border-muted transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  aria-label={tr("Copy debug information for bug reports")}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ?tr("Copied!") :tr("Copy debug info")}
                </button>
                <a
                  href="https://github.com/MMM-pay"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >{tr("GitHub")}</a>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
