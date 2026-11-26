import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import TemplateDetail from "./template-detail";

const api = vi.hoisted(() => ({
  info: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const document = vi.hoisted(() => ({ setContent: vi.fn() }));
vi.mock("./template-api", async (original) => ({
  ...(await original<typeof import("./template-api")>()),
  templateInfo: api.info,
  updateTemplate: api.update,
  deleteTemplate: api.remove,
}));
vi.mock("./template-destination", () => ({ TemplateDestination: () => null }));
vi.mock("@/features/editor/extensions/extensions", () => ({
  templateExtensions: [],
}));
vi.mock("@tiptap/react", () => ({
  useEditor: () => ({
    getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }),
    commands: { setContent: document.setContent },
    setEditable: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }),
  EditorContent: () => <div role="textbox" aria-label="Template body" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}));
const record = {
  id: "template-id",
  title: "Meeting",
  description: "Agenda",
  content: { type: "doc", content: [] },
  updatedAt: "2026-11-25T18:00:00.123Z",
  canManage: true,
};
function show() {
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
        <MemoryRouter initialEntries={["/templates/template-id"]}>
          <Routes>
            <Route path="/templates/:templateId" element={<TemplateDetail />} />
            <Route path="/templates" element={<div>Library route</div>} />
          </Routes>
        </MemoryRouter>
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
  Object.values(api).forEach((fn) => fn.mockReset());
  document.setContent.mockReset();
  api.info.mockResolvedValue(record);
  api.update.mockResolvedValue({
    ...record,
    updatedAt: "2026-11-25T18:00:01.123Z",
  });
  api.remove.mockResolvedValue(undefined);
});
afterEach(cleanup);
it("saves with the server revision and does not claim success until the request finishes", async () => {
  show();
  fireEvent.change(await screen.findByLabelText("Title"), {
    target: { value: "Revised" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save template" }));
  await waitFor(() =>
    expect(api.update.mock.calls[0]?.[0]).toMatchObject({
      templateId: record.id,
      title: "Revised",
      expectedUpdatedAt: record.updatedAt,
    }),
  );
  expect(await screen.findByText("Saved")).toBeTruthy();
});
it("keeps management controls unavailable for non-authors", async () => {
  api.info.mockResolvedValue({ ...record, canManage: false });
  show();
  await screen.findByRole("button", { name: "Use template" });
  expect(screen.queryByRole("button", { name: "Save template" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete template" })).toBeNull();
  expect(screen.queryByLabelText("Title")).toBeNull();
});
it("shows save errors without replacing the local draft", async () => {
  api.update.mockRejectedValue({
    response: { data: { message: "Template changed; reload before saving" } },
  });
  show();
  fireEvent.change(await screen.findByLabelText("Title"), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save template" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
    "My draft",
  );
  expect(screen.queryByText("Saved")).toBeNull();
});
it("requires an explicit delete confirmation", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete template" }),
  );
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm delete" }),
  );
  await waitFor(() => expect(api.remove.mock.calls[0]?.[0]).toBe(record.id));
  expect(await screen.findByText("Library route")).toBeTruthy();
});
it("loads the server-remapped attachment references after saving", async () => {
  const content = {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: {
          attachmentId: "new-file",
          src: "/api/templates/files/new-file/image.png",
        },
      },
    ],
  };
  api.update.mockResolvedValue({ ...record, content });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Save template" }));
  await waitFor(() =>
    expect(document.setContent).toHaveBeenCalledWith(content, {
      emitUpdate: false,
    }),
  );
});
