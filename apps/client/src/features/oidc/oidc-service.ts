import api from "@/lib/api-client";

export interface OidcProvider {
  id: string;
  issuer: string;
  clientId?: string;
  isEnabled?: boolean;
  linked?: boolean;
}

export interface OidcStatus {
  canManage: boolean;
  callbackUrl: string;
  providers: OidcProvider[];
}

export interface OidcConfiguration {
  id?: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  isEnabled: boolean;
  password: string;
}

export async function getOidcProviders(): Promise<OidcProvider[]> {
  return (await api.post<OidcProvider[]>("/oidc/providers")).data;
}
export async function getOidcStatus(): Promise<OidcStatus> {
  return (await api.post<OidcStatus>("/oidc/status")).data;
}
export async function startOidc(
  providerId: string,
): Promise<{ authorizationUrl: string }> {
  return (await api.post("/oidc/start", { providerId })).data;
}
export async function linkOidc(
  providerId: string,
  password: string,
): Promise<{ authorizationUrl: string }> {
  return (await api.post("/oidc/link", { providerId, password })).data;
}
export async function configureOidc(
  value: OidcConfiguration,
): Promise<OidcProvider> {
  return (await api.post<OidcProvider>("/oidc/configure", value)).data;
}
export function redirectToOidc(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid SSO destination");
  window.location.assign(url.href);
}
