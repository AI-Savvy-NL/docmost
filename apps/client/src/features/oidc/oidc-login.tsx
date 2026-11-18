import { useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getOidcProviders, redirectToOidc, startOidc } from "./oidc-service";

export function OidcLogin() {
  const { t } = useTranslation();
  const providers = useQuery({
    queryKey: ["oidc", "providers"],
    queryFn: getOidcProviders,
    retry: false,
  });
  const [starting, setStarting] = useState("");
  const [failed, setFailed] = useState(
    new URLSearchParams(window.location.search).get("oidc") === "error",
  );

  async function begin(id: string) {
    if (starting) return;
    setFailed(false);
    setStarting(id);
    try {
      const result = await startOidc(id);
      redirectToOidc(result.authorizationUrl);
    } catch {
      setFailed(true);
    } finally {
      setStarting("");
    }
  }

  if (providers.isLoading)
    return (
      <Text size="sm" role="status">
        {t("Checking SSO availability…")}
      </Text>
    );
  return (
    <Stack
      gap="xs"
      mb={providers.data?.length || failed || providers.isError ? "md" : 0}
    >
      {(failed || providers.isError) && (
        <Alert color="red" role="alert">
          {t("SSO sign-in could not complete. Try again or use your password.")}
        </Alert>
      )}
      {providers.isError && (
        <Button variant="subtle" onClick={() => providers.refetch()}>
          {t("Retry SSO availability")}
        </Button>
      )}
      {providers.data?.map((provider) => (
        <Button
          key={provider.id}
          variant="outline"
          disabled={Boolean(starting)}
          loading={starting === provider.id}
          onClick={() => begin(provider.id)}
        >
          {t("Sign in with SSO")} · {new URL(provider.issuer).hostname}
        </Button>
      ))}
    </Stack>
  );
}
