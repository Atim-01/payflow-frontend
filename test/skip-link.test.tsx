// @vitest-environment jsdom
/**
 * Verifies that the "Skip to content" link and the matching `id` on <main>
 * are both present in the rendered app shell, so keyboard and screen-reader
 * users can bypass the header navigation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WalletLayoutInner } from "@/components/WalletLayoutInner";

vi.mock("@/lib/wallet", () => ({
  useWallet: () => ({
    address: null,
    connecting: false,
    error: null,
    networkMismatch: false,
    walletNetwork: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    signXdr: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/lib/config", () => ({
  config: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contracts: {
      planRegistry: "",
      vault: "",
      subscription: "",
    },
  },
  explorerBase: "https://stellar.expert/explorer/testnet",
}));

vi.mock("@/lib/build-info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/build-info")>();
  return { ...actual, APP_VERSION: "0.0.0", COMMIT_HASH: "" };
});

afterEach(() => {
  cleanup();
});

describe("Skip-to-content link", () => {
  it("renders a 'Skip to content' link that targets #main-content", () => {
    render(
      <WalletLayoutInner>
        <p>Page content</p>
      </WalletLayoutInner>,
    );

    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    expect(skipLink.getAttribute("href")).toBe("#main-content");
  });

  it("the skip link target id exists on the <main> element", () => {
    render(
      <WalletLayoutInner>
        <p>Page content</p>
      </WalletLayoutInner>,
    );

    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
  });

  it("the skip link appears before the header in the DOM", () => {
    render(
      <WalletLayoutInner>
        <p>Page content</p>
      </WalletLayoutInner>,
    );

    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    const header = document.querySelector("header");

    expect(header).toBeTruthy();
    // compareDocumentPosition returns a bitmask; bit 4 (0x4) means
    // skipLink comes before header in document order.
    const position = skipLink.compareDocumentPosition(header!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
