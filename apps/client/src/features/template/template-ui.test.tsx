import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import TemplatesPage from "./templates-page";
import TemplatePicker from "./template-picker";
import { applyPreparedTemplate } from "./template-editor-utils";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  info: vi.fn(),
  use: vi.fn(),
  navigate: vi.fn(),
  isAdmin: false,
}));
vi.mock("./template-api", async (original) => ({
  ...(await original<typeof import("./template-api")>()),
  listTemplates: mocks.list,
  createTemplate: mocks.create,
  templateInfo: mocks.info,
  useTemplate: mocks.use,
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isAdmin: mocks.isAdmin }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}));
vi.mock("@/features/page/queries/page-query", () => ({
  invalidateOnCreatePage: vi.fn(),
}));
vi.mock("@/components/ui/destination-picker/destination-picker-modal", () => ({
  DestinationPickerModal: ({ opened, onSelect, error }: any) =>
    opened ? (
      <div role="dialog" aria-label="Fixture destination">
        <button
          onClick={() =>
            onSelect({
              type: "page",
              pageId: "source-id",
              spaceId: "space-id",
              page: { title: "Source page" },
              space: { slug: "space" },
            })
          }
        >
          Choose fixture page
        </button>
        {error && <div role="alert">{error}</div>}
      </div>
    ) : null,
}));
const template = {
  id: "template-id",
  title: "Meeting notes",
  description: "Reusable agenda",
  workspaceId: "workspace-id",
  creatorId: "creator-id",
  canManage: true,
  updatedAt: "2026-11-25T18:00:00Z",
};
const page = (items = [template], hasNextPage = false) => ({
  items,
  meta: { hasNextPage, nextCursor: hasNextPage ? "next" : null },
});
function show(element: React.ReactNode) {
  return render(
    <MantineProvider>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  mocks.isAdmin = false;
  Object.values(mocks).forEach((mock) => {
    if (typeof mock === "function") mock.mockReset();
  });
  mocks.list.mockResolvedValue(page());
  mocks.create.mockResolvedValue({ ...template, id: "new-template" });
});
afterEach(cleanup);

describe("Independent Templates UI", () => {
  it("shows templates for members without an upgrade gate", async () => {
    show(<TemplatesPage />);
    expect(await screen.findByText("Meeting notes")).toBeTruthy();
    expect(screen.queryByText(/paid license|upgrade/i)).toBeNull();
    expect(screen.getByRole("button", { name: "New template" })).toBeTruthy();
  });
  it("shows a loading state followed by an empty library", async () => {
    let resolve: (value: any) => void;
    mocks.list.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    show(<TemplatesPage />);
    expect(screen.getByRole("status")).toBeTruthy();
    resolve(page([]));
    expect(await screen.findByText("No templates yet")).toBeTruthy();
  });
  it("shows an error and allows retry instead of disguising failure as an empty library", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(page([]));
    show(<TemplatesPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No templates yet")).toBeTruthy();
  });
  it("lets an ordinary member create a blank template", async () => {
    show(<TemplatesPage />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Reusable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    await waitFor(() =>
      expect(mocks.create.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ title: "Reusable" }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/templates/new-template");
  });
  it("never silently confirms restricted-source publication for a member", async () => {
    show(<TemplatesPage />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose source page" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose fixture page" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create template" }),
    );
    await waitFor(() =>
      expect(mocks.create.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          sourcePageId: "source-id",
          confirmRestrictedSource: false,
        }),
      ),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("requires an explicit admin checkbox before sending restricted-source confirmation", async () => {
    mocks.isAdmin = true;
    show(<TemplatesPage />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose source page" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose fixture page" }),
    );
    const confirmation = await screen.findByRole("checkbox", {
      name: /publish restricted/i,
    });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    await waitFor(() =>
      expect(mocks.create.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ confirmRestrictedSource: true }),
      ),
    );
  });
  it("paginates the picker and delegates selection to the existing-page flow", async () => {
    mocks.list
      .mockResolvedValueOnce(page([template], true))
      .mockResolvedValueOnce(
        page([{ ...template, id: "second", title: "Second" }]),
      );
    const use = vi.fn();
    show(<TemplatePicker opened onClose={vi.fn()} onUse={use} />);
    await screen.findByText("Meeting notes");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Second" }));
    await waitFor(() =>
      expect(use).toHaveBeenCalledWith(
        expect.objectContaining({ id: "second" }),
      ),
    );
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "next" }),
    );
  });
  it("keeps destination errors visible inside the open dialog", async () => {
    mocks.use.mockRejectedValue({
      response: { data: { message: "Destination is not writable" } },
    });
    show(<TemplatePicker opened onClose={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Meeting notes" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose fixture page" }),
    );
    const alert = await screen.findByRole("alert");
    expect(
      screen
        .getByRole("dialog", { name: "Fixture destination" })
        .contains(alert),
    ).toBe(true);
  });
});

describe("Applying a prepared snapshot to an empty live editor", () => {
  it("refuses to overwrite a page that became nonempty while files were prepared", () => {
    const editor = {
      isEmpty: false,
      isDestroyed: false,
      commands: { setContent: vi.fn() },
    };
    expect(
      applyPreparedTemplate(editor as any, {} as any, {
        title: "Template",
        content: {},
      }),
    ).toBe(false);
    expect(editor.commands.setContent).not.toHaveBeenCalled();
  });
  it("uses the prepared page-owned body and inserts title as text, not HTML", () => {
    const editor = {
      isEmpty: true,
      isDestroyed: false,
      commands: { setContent: vi.fn() },
    };
    const title = {
      isEmpty: true,
      isDestroyed: false,
      commands: { insertContent: vi.fn() },
    };
    const prepared = {
      title: "<img src=x>",
      content: { type: "doc", content: [] },
    };
    expect(applyPreparedTemplate(editor as any, title as any, prepared)).toBe(
      true,
    );
    expect(editor.commands.setContent).toHaveBeenCalledWith(prepared.content);
    expect(title.commands.insertContent).toHaveBeenCalledWith({
      type: "text",
      text: prepared.title,
    });
  });
});
