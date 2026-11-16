import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { HelmetProvider } from "react-helmet-async";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LicenseEdition from "./license-edition.tsx";

vi.mock("@/features/licensing/components/license-manager.tsx", () => ({
  default: () => null,
}));

const i18n = createInstance();

function renderEdition() {
  return render(
    <HelmetProvider>
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <LicenseEdition />
        </I18nextProvider>
      </MantineProvider>
    </HelmetProvider>,
  );
}

describe("LicenseEdition", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("identifies WikiSavvy without upstream product branding", () => {
    renderEdition();
    expect(
      screen.getByRole("heading", { name: "License & Edition" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "WikiSavvy" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/docmost/i);
  });

  it("links to the actual upstream core license", () => {
    renderEdition();
    const link = screen.getByRole("link", {
      name: "GNU Affero General Public License v3.0 (AGPL-3.0)",
    });
    expect(link.getAttribute("href")).toBe(
      "https://www.gnu.org/licenses/agpl-3.0.html",
    );
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("does not claim that rebranding enables enterprise features", () => {
    renderEdition();
    expect(
      screen.getByText(
        "Third-party components retain their respective licenses.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/purchase|contact sales/i);
  });

  it("does not render upstream purchase or activation controls in the licensing information", () => {
    renderEdition();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).not.toContain("docmost.com");
  });

  it("renders without requesting licensing services", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    renderEdition();
    expect(fetch).not.toHaveBeenCalled();
  });
});
