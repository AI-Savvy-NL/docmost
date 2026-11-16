import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { HelmetProvider } from "react-helmet-async";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import DocsFooterBranding from "@/features/public-space/components/docs/docs-footer-branding.tsx";
import PublicSpaceDirectoryPage from "@/pages/public-space/public-space-directory-page.tsx";
import Connections from "@/features/integration/pages/connections.tsx";
import Integrations from "@/features/integration/pages/integrations.tsx";
import HomeAiPrompt from "@/features/home/components/home-ai-prompt.tsx";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  available: [] as any[],
  installed: [] as any[],
  workspace: undefined as any,
}));
vi.mock("@mantine/modals", () => ({
  modals: { open: mocks.open, close: mocks.close, openConfirmModal: vi.fn() },
}));
vi.mock("jotai", async (original) => ({
  ...(await original<typeof import("jotai")>()),
  useAtomValue: () => mocks.workspace,
}));
vi.mock("@/ee/ai-chat/components/chat-input", () => ({ default: () => null }));
vi.mock("@/ee/announcement/components/announcement-banners.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/public-space/queries/public-space-query.ts", () => ({
  usePublicSpaceDirectoryQuery: () => ({
    data: { spaces: [] },
    isLoading: false,
  }),
}));
vi.mock("@/features/public-space/hooks/use-authenticated-user.ts", () => ({
  useAuthenticatedUser: () => ({ data: null }),
}));
vi.mock("@/features/integration/components/connection-row", () => ({
  default: () => null,
}));
vi.mock("@/features/integration/components/integration-row", () => ({
  default: () => null,
}));
vi.mock("@/features/integration/queries/integration-query", () => ({
  useAvailableIntegrations: () => ({ data: mocks.available, isLoading: false }),
  useInstalledIntegrations: () => ({ data: mocks.installed, isLoading: false }),
  useMyConnections: () => ({ data: [], isLoading: false }),
  useDisconnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
  useUninstallIntegration: () => ({ mutate: vi.fn(), isPending: false }),
}));
const locales = resolve(import.meta.dirname, "../../public/locales");
const translations = (locale: string) =>
  JSON.parse(
    readFileSync(resolve(locales, locale, "translation.json"), "utf8"),
  );
const i18n = createInstance();

function show(component: React.ReactNode, path = "/") {
  window.history.replaceState(null, "", path);
  return render(
    <HelmetProvider>
      <MantineProvider>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[path]}>{component}</MemoryRouter>
        </I18nextProvider>
      </MantineProvider>
    </HelmetProvider>,
  );
}
describe("Ordinary WikiSavvy UI branding", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    });
    await i18n.init({
      lng: "nl-NL",
      fallbackLng: "en-US",
      resources: {
        "nl-NL": { translation: translations("nl-NL") },
        "en-US": { translation: translations("en-US") },
      },
    });
  });
  beforeEach(() => {
    mocks.available = [];
    mocks.installed = [];
    mocks.workspace = undefined;
    mocks.open.mockClear();
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("brands public docs without an upstream marketing link", () => {
    show(<DocsFooterBranding />);
    expect(document.body.textContent).toContain("WikiSavvy");
    expect(document.body.textContent).not.toMatch(/docmost/i);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("brands the empty public directory without exposing a marketing link", () => {
    show(<PublicSpaceDirectoryPage />);
    expect(document.body.textContent).toContain("WikiSavvy");
    expect(document.body.textContent).not.toMatch(/docmost/i);
    expect(document.querySelector('a[href*="docmost.com"]')).toBeNull();
  });
  it.each(["identity_mismatch", "tenant_mismatch"])(
    "brands translated connection failure %s",
    (error) => {
      show(<Connections />, "/settings/account/connections?error=" + error);
      expect(document.body.textContent).toContain("WikiSavvy");
      expect(document.body.textContent).not.toMatch(/docmost/i);
    },
  );
  it("brands the translated integration conflict and removes upstream documentation links", () => {
    show(<Integrations />, "/settings/integrations?error=tenant_in_use");
    expect(document.body.textContent).toContain("WikiSavvy");
    expect(document.body.textContent).not.toMatch(/docmost/i);
    expect(document.querySelector('a[href*="docmost.com"]')).toBeNull();
  });
  it("brands the Slack connection prompt and its translated explanation", () => {
    mocks.available = [
      { type: "slack", name: "Slack", capabilities: ["oauth"] },
    ];
    mocks.installed = [{ type: "slack", id: "slack-installation" }];
    show(<Connections />, "/settings/account/connections?connect=slack");
    expect(mocks.open).toHaveBeenCalledOnce();
    const prompt = mocks.open.mock.calls[0][0];
    expect(prompt.title).toContain("WikiSavvy");
    expect(prompt.title).not.toMatch(/docmost/i);
    show(prompt.children);
    expect(document.body.textContent).toContain("WikiSavvy");
    expect(document.body.textContent).not.toMatch(/docmost/i);
  });
  it("uses the app name when an enabled home prompt has no workspace name", () => {
    mocks.workspace = { settings: { ai: { chat: true } } };
    show(<HomeAiPrompt />);
    expect(screen.getByRole("heading").textContent).toContain("WikiSavvy");
  });
  it("does not rewrite a user-provided workspace name", () => {
    mocks.workspace = {
      name: "Docmost migration notes",
      settings: { ai: { chat: true } },
    };
    show(<HomeAiPrompt />);
    expect(screen.getByRole("heading").textContent).toContain(
      "Docmost migration notes",
    );
  });
  it("has no upstream support email in the settings sidebar source", () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        "../components/settings/settings-sidebar.tsx",
      ),
      "utf8",
    );
    expect(source).not.toContain("mailto:help@docmost.com");
  });
  it.each(readdirSync(locales))(
    "keeps translated branding and interpolation valid in %s",
    async (locale) => {
      const instance = createInstance();
      await instance.init({
        lng: locale,
        resources: { [locale]: { translation: translations(locale) } },
      });
      const key = "Connect {{name}} to {{appName}}";
      expect(translations(locale)).toHaveProperty(key);
      const value = instance.t(key, { name: "Slack", appName: "WikiSavvy" });
      expect(value).toContain("WikiSavvy");
      expect(value).toContain("Slack");
      expect(value).not.toMatch(/docmost|\{\{/i);
    },
  );
});
