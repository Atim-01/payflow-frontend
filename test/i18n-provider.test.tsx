// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from "@/i18n/provider";
import { LanguagePicker } from "@/i18n/LanguagePicker";
import { AmountInput } from "@/components/AmountInput";

function Form() {
  const { t, locale, parseAmount } = useI18n();
  const [amount, setAmount] = useState("1.234");
  const [account, setAccount] = useState("GACCOUNT_A");
  const [pending, setPending] = useState(false);
  return <><LanguagePicker /><p>{t("No wallet connected")}</p><p>{t("Wrong network")}</p>
    <AmountInput id="deposit" label={t("Amount")} value={amount} decimals={7} onChange={setAmount} />
    <output data-testid="stroops">{String(parseAmount(amount))}</output>
    <button onClick={() => setAccount("GACCOUNT_B")}>switch account</button><output>{account}</output>
    <button onClick={() => setPending(true)}>start request</button><output>{String(pending)}</output>
    <output data-testid="locale">{locale}</output></>;
}
const app = () => <I18nProvider><Form /></I18nProvider>;
beforeEach(() => { localStorage.clear(); document.documentElement.lang = "en"; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("persistent locale without remounting wallet or form state", () => {
  it("restores French, localizes decimal entry and retains active state on language changes", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    render(app());
    await screen.findByText("Aucun portefeuille connecté");
    expect(document.documentElement.lang).toBe("fr");
    expect(screen.getByTestId("stroops").textContent).toBe("12340000");
    expect(screen.getByLabelText("Montant")).toBeTruthy();
    fireEvent.click(screen.getByText("switch account"));
    fireEvent.click(screen.getByText("start request"));
    fireEvent.change(screen.getByRole("combobox", { name: "Langue" }), { target: { value: "en" } });
    expect(screen.getByText("GACCOUNT_B")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(screen.getByTestId("stroops").textContent).toBe("12340000");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("1.234");
    expect(screen.getByText("Wrong network")).toBeTruthy();
  });
  it("synchronizes valid changes across tabs and rejects unsupported locales", async () => {
    render(app());
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "fr" })));
    expect(screen.getByTestId("locale").textContent).toBe("fr");
    fireEvent.change(screen.getByRole("combobox", { name: "Langue" }), { target: { value: "es" } });
    expect(screen.getByTestId("locale").textContent).toBe("fr");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: null })));
    expect(screen.getByTestId("locale").textContent).toBe("en");
  });
  it("works when localStorage access is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(app());
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "fr" } });
    expect(screen.getByText("Aucun portefeuille connecté")).toBeTruthy();
  });
  it("hydrates the English static export before adopting stored French without mismatch", async () => {
    const container = document.createElement("div");
    // Parse the trusted SSR fixture in an inert document, without an HTML execution sink.
    const snapshot = new DOMParser().parseFromString(renderToString(app()), "text/html");
    container.replaceChildren(...Array.from(snapshot.body.childNodes));
    expect(container.textContent).toContain("No wallet connected");
    document.body.appendChild(container);
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, app()); });
    await waitFor(() => expect(container.textContent).toContain("Aucun portefeuille connecté"));
    expect(errors.flat().join(" ")).not.toMatch(/hydration|didn't match|did not match/i);
    await act(async () => root.unmount());
    container.remove(); spy.mockRestore();
  });
});
