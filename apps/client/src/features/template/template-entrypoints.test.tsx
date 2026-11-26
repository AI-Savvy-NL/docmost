import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MantineProvider } from "@mantine/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EmptyPageGetStarted } from "@/features/editor/components/empty-page/empty-page-get-started";

const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  notify: vi.fn(),
  body: {
    isEmpty: true,
    isDestroyed: false,
    on: vi.fn(),
    off: vi.fn(),
    commands: { setContent: vi.fn() },
  },
  title: {
    isEmpty: true,
    isDestroyed: false,
    commands: { insertContent: vi.fn() },
  },
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: string) =>
    atom === "body" ? fixture.body : atom === "title" ? fixture.title : true,
}));
vi.mock("@/features/editor/atoms/editor-atoms", () => ({
  pageEditorAtom: "body",
  titleEditorAtom: "title",
  yjsSyncedAtom: "synced",
}));
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));
vi.mock("@/ee/base/queries/base-query", () => ({
  useConvertPageToBaseMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/ee/template/services/template-service.ts", () => ({
  getTemplateById: vi.fn(),
}));
vi.mock("./template-api", () => ({ prepareTemplate: fixture.prepare }));
vi.mock("./template-picker", () => ({
  default: ({ onUse }: any) => (
    <button onClick={() => void onUse({ id: "template-id" })}>
      Choose fixture template
    </button>
  ),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: fixture.notify },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}));
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
beforeEach(() => {
  fixture.body.isEmpty = true;
  fixture.body.commands.setContent.mockClear();
  fixture.prepare.mockReset();
  fixture.prepare.mockResolvedValue({
    title: "Saved title",
    content: { type: "doc", content: [] },
  });
});
afterEach(cleanup);
it("uses independent routes and original entry points without granting legacy EE entitlements", () => {
  const source = (path: string) => readFileSync(resolve("src", path), "utf8");
  for (const path of [
    "App.tsx",
    "components/layouts/global/global-sidebar.tsx",
    "features/space/components/sidebar/space-sidebar.tsx",
    "features/editor/components/empty-page/empty-page-get-started.tsx",
  ]) {
    const text = source(path);
    expect(text).not.toContain("@/ee/template/");
    expect(text).not.toContain("Feature.TEMPLATES");
    expect(text).toContain("/template");
  }
  expect(source("pages/settings/workspace/workspace-settings.tsx")).toContain(
    "@/features/template/member-template-policy",
  );
});
it("prepares current-page-owned attachments even when the old entitlement is false", async () => {
  render(
    <MantineProvider>
      <EmptyPageGetStarted pageId="page-id" spaceId="space-id" editable />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Template" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose fixture template" }),
  );
  await waitFor(() =>
    expect(fixture.prepare).toHaveBeenCalledWith("template-id", "page-id"),
  );
  expect(fixture.body.commands.setContent).toHaveBeenCalledWith({
    type: "doc",
    content: [],
  });
});
it("does not overwrite live edits that arrive while preparation is running", async () => {
  fixture.prepare.mockImplementationOnce(async () => {
    fixture.body.isEmpty = false;
    return { title: "Saved title", content: {} };
  });
  render(
    <MantineProvider>
      <EmptyPageGetStarted pageId="page-id" spaceId="space-id" editable />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Template" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose fixture template" }),
  );
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalled());
  expect(fixture.body.commands.setContent).not.toHaveBeenCalled();
});
