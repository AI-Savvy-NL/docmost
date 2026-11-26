import api from "@/lib/api-client";
import { IPagination, QueryParams } from "@/lib/types";
import { IPage } from "@/features/page/types/page.types";

export type TemplateRecord = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  content?: any;
  creatorId: string;
  workspaceId: string;
  canManage: boolean;
  updatedAt: string;
};
export type TemplateInput = {
  title?: string;
  description?: string;
  icon?: string;
  content?: any;
  sourcePageId?: string;
  confirmRestrictedSource?: boolean;
};
export async function listTemplates(
  params: QueryParams = {},
): Promise<IPagination<TemplateRecord>> {
  return (await api.post("/templates", params)).data;
}
export async function templateInfo(
  templateId: string,
): Promise<TemplateRecord> {
  return (await api.post("/templates/info", { templateId })).data;
}
export async function createTemplate(
  input: TemplateInput,
): Promise<TemplateRecord> {
  return (await api.post("/templates/create", input)).data;
}
export async function updateTemplate(
  input: TemplateInput & { templateId: string; expectedUpdatedAt: string },
): Promise<TemplateRecord> {
  return (await api.post("/templates/update", input)).data;
}
export async function deleteTemplate(templateId: string): Promise<void> {
  await api.post("/templates/delete", { templateId });
}
export async function useTemplate(input: {
  templateId: string;
  spaceId: string;
  parentPageId?: string;
}): Promise<IPage> {
  return (await api.post("/templates/use", input)).data;
}
export async function prepareTemplate(
  templateId: string,
  pageId: string,
): Promise<{ title: string; content: any }> {
  return (await api.post("/templates/prepare", { templateId, pageId })).data;
}
export function templateError(error: any, fallback: string): string {
  const message = error?.response?.data?.message;
  return typeof message === "string" ? message : fallback;
}
