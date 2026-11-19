import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OidcLogin } from "./oidc-login";
import { OidcAccount } from "./oidc-account";
import { OidcWorkspace } from "./oidc-workspace";

const api = vi.hoisted(() => ({
  providers: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  link: vi.fn(),
  configure: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("./oidc-service", () => ({
  getOidcProviders: api.providers,
  getOidcStatus: api.status,
  startOidc: api.start,
  linkOidc: api.link,
  configureOidc: api.configure,
  redirectToOidc: api.redirect,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}));

const provider = {
  id: "11111111-1111-4111-8111-111111111111",
  issuer: "https://identity.example.invalid/application/o/wiki/",
  clientId: "public-client-id",
  isEnabled: true,
  linked: false,
};
const status = {
  canManage: false,
  callbackUrl: "https://wiki.example.invalid/api/oidc/callback",
  providers: [provider],
};
function show(component: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>{component}</QueryClientProvider>
    </MantineProvider>,
  );
}

describe("Independent optional SSO controls", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.providers.mockResolvedValue([
      { id: provider.id, issuer: "https://identity.example.invalid" },
    ]);
    api.status.mockResolvedValue(status);
    api.start.mockResolvedValue({
      authorizationUrl:
        "https://identity.example.invalid/authorize?state=synthetic",
    });
    api.link.mockResolvedValue({
      authorizationUrl:
        "https://identity.example.invalid/authorize?state=synthetic",
    });
    api.configure.mockResolvedValue(provider);
    window.history.replaceState(null, "", "/login");
  });
  afterEach(cleanup);

  it("starts optional SSO without requesting or transmitting a local password", async () => {
    show(<OidcLogin />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Sign in with SSO/ }),
    );
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(provider.id));
    expect(api.redirect).toHaveBeenCalledTimes(1);
    expect(api.link).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
  it("does not show an SSO button when no provider is configured", async () => {
    api.providers.mockResolvedValue([]);
    show(<OidcLogin />);
    await waitFor(() => expect(api.providers).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Sign in with SSO/ }),
    ).toBeNull();
  });
  it("shows a safe start failure and leaves password sign-in as an explicit choice", async () => {
    api.start.mockRejectedValue(new Error("synthetic-provider-error"));
    show(<OidcLogin />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Sign in with SSO/ }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.redirect).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("synthetic-provider-error");
  });
  it("shows callback failure even when no provider can be listed", async () => {
    window.history.replaceState(null, "", "/login?oidc=error");
    api.providers.mockResolvedValue([]);
    show(<OidcLogin />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
  it("shows a retry control on account status failure", async () => {
    api.status.mockRejectedValue(new Error("synthetic-status-error"));
    show(<OidcAccount />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry SSO status" }),
    ).toBeTruthy();
  });
  it("requires explicit password reauthentication before linking an existing account", async () => {
    show(<OidcAccount />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Link account" }),
    );
    const confirm = screen.getByRole("button", {
      name: "Continue to identity provider",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Current password to link SSO/), {
      target: { value: "synthetic-confirmation" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.link).toHaveBeenCalledWith(
        provider.id,
        "synthetic-confirmation",
      ),
    );
    expect(api.redirect).toHaveBeenCalledTimes(1);
    expect(api.configure).not.toHaveBeenCalled();
  });
  it("does not offer account relinking or owner configuration to ordinary members", async () => {
    api.status.mockResolvedValue({
      ...status,
      providers: [{ ...provider, linked: true }],
    });
    show(<OidcAccount />);
    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Configure SSO provider" }),
    ).toBeNull();
  });
  it("shows an empty account state without implying signup or mandatory SSO", async () => {
    api.status.mockResolvedValue({ ...status, providers: [] });
    show(<OidcAccount />);
    expect(await screen.findByText(/No SSO provider is enabled/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /automatic signup|SSO required/,
    );
  });
  it("keeps owner provider management out of the personal profile", async () => {
    api.status.mockResolvedValue({ ...status, canManage: true });
    show(<OidcAccount />);
    expect(
      await screen.findByRole("button", { name: "Link account" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Configure SSO provider" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit SSO provider" }),
    ).toBeNull();
  });
  it("requires explicit enablement and password confirmation in the owner form", async () => {
    api.status.mockResolvedValue({ ...status, canManage: true });
    show(<OidcWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Configure SSO provider" }),
    );
    const enable = screen.getByLabelText(
      "Enable optional SSO",
    ) as HTMLInputElement;
    expect(enable.checked).toBe(false);
    fireEvent.change(screen.getByLabelText(/^OIDC issuer/), {
      target: { value: provider.issuer },
    });
    fireEvent.change(screen.getByLabelText(/^OIDC client identifier/), {
      target: { value: provider.clientId },
    });
    fireEvent.change(screen.getByLabelText(/^OIDC client secret/), {
      target: { value: "synthetic-client-proof" },
    });
    fireEvent.change(
      screen.getByLabelText(/^Current password to configure SSO/),
      { target: { value: "synthetic-confirmation" } },
    );
    fireEvent.click(enable);
    fireEvent.click(screen.getByRole("button", { name: "Save SSO provider" }));
    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          isEnabled: true,
          password: "synthetic-confirmation",
          clientSecret: "synthetic-client-proof",
        }),
      ),
    );
    expect(api.redirect).not.toHaveBeenCalled();
  });
  it("clears sensitive owner form inputs after a failed request", async () => {
    api.status.mockResolvedValue({ ...status, canManage: true });
    api.configure.mockRejectedValue(new Error("synthetic-save-error"));
    show(<OidcWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Configure SSO provider" }),
    );
    fireEvent.change(screen.getByLabelText(/^OIDC issuer/), {
      target: { value: provider.issuer },
    });
    fireEvent.change(screen.getByLabelText(/^OIDC client identifier/), {
      target: { value: provider.clientId },
    });
    fireEvent.change(screen.getByLabelText(/^OIDC client secret/), {
      target: { value: "synthetic-client-proof" },
    });
    fireEvent.change(
      screen.getByLabelText(/^Current password to configure SSO/),
      { target: { value: "synthetic-confirmation" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save SSO provider" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/^OIDC client secret/) as HTMLInputElement)
          .value,
      ).toBe(""),
    );
    expect(
      (
        screen.getByLabelText(
          /^Current password to configure SSO/,
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(api.redirect).not.toHaveBeenCalled();
  });

  it("focuses the linking confirmation and keeps password visibility keyboard reachable", async () => {
    show(<OidcAccount />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Link account" }),
    );
    const input = screen.getByLabelText(
      /^Current password to link SSO/,
    ) as HTMLInputElement;
    expect(document.activeElement === input).toBe(true);
    const toggle = screen.getByRole("button", {
      name: "Show or hide SSO confirmation password",
    }) as HTMLButtonElement;
    expect(toggle.tabIndex).toBe(0);
    fireEvent.keyDown(toggle, { key: " " });
    expect(input.type).toBe("text");
  });

  it("focuses new provider configuration and labels its keyboard-accessible secret toggle", async () => {
    api.status.mockResolvedValue({ ...status, canManage: true });
    show(<OidcWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Configure SSO provider" }),
    );
    const issuer = screen.getByLabelText(/^OIDC issuer/) as HTMLInputElement;
    expect(document.activeElement === issuer).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Show or hide OIDC client secret",
        }) as HTMLButtonElement
      ).tabIndex,
    ).toBe(0);
  });
  it("keeps non-owner workspace management unavailable", async () => {
    show(<OidcWorkspace />);
    expect(
      await screen.findByText(
        "Only the workspace owner can manage SSO providers.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Configure SSO provider" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit SSO provider" }),
    ).toBeNull();
    expect(api.configure).not.toHaveBeenCalled();
  });
  it("keeps personal linking out of workspace configuration", async () => {
    api.status.mockResolvedValue({ ...status, canManage: true });
    show(<OidcWorkspace />);
    expect(
      await screen.findByRole("button", { name: "Edit SSO provider" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
    expect(api.link).not.toHaveBeenCalled();
  });
  it("allows retry after a workspace status failure", async () => {
    api.status
      .mockRejectedValueOnce(new Error("synthetic-status-error"))
      .mockResolvedValue({ ...status, canManage: true, providers: [] });
    show(<OidcWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry SSO status" }),
    );
    expect(
      await screen.findByText("No OIDC provider is configured."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("synthetic-status-error");
  });
});
