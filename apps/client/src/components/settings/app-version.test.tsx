import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import AppVersion from "./app-version.tsx";

const { useAppVersion } = vi.hoisted(() => ({ useAppVersion: vi.fn() }));

vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useAppVersion,
}));

const i18n = createInstance();

function renderVersion() {
  return render(
    <MantineProvider>
      <I18nextProvider i18n={i18n}>
        <AppVersion />
      </I18nextProvider>
    </MantineProvider>,
  );
}

describe("AppVersion", () => {
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

  beforeEach(() => {
    useAppVersion.mockReturnValue({
      data: { currentVersion: "0.97.0", latestVersion: "1.0.0" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("labels the actual backend version as the WikiSavvy base version", () => {
    renderVersion();
    expect(screen.getByText("WikiSavvy — base v0.97.0")).toBeTruthy();
  });

  it("does not offer upstream releases even when an upstream update exists", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderVersion();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("New update")).toBeNull();
    fireEvent.click(screen.getByText("WikiSavvy — base v0.97.0"));
    expect(open).not.toHaveBeenCalled();
  });

  it("shows the app name while the version is loading", () => {
    useAppVersion.mockReturnValue({ data: undefined, isLoading: true });
    renderVersion();
    expect(screen.getByText("WikiSavvy")).toBeTruthy();
  });

  it("keeps the app name if the version request fails", () => {
    useAppVersion.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error("Version request failed"),
    });
    renderVersion();
    expect(screen.getByText("WikiSavvy")).toBeTruthy();
  });

  it("does not display an empty base version", () => {
    useAppVersion.mockReturnValue({
      data: { currentVersion: "", latestVersion: "1.0.0" },
    });
    renderVersion();
    expect(screen.getByText("WikiSavvy")).toBeTruthy();
    expect(screen.queryByText(/base v/)).toBeNull();
  });
});
