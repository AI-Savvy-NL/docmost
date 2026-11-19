import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getOidcStatus, linkOidc, redirectToOidc } from "./oidc-service";

export function OidcAccount() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ["oidc", "account"],
    queryFn: getOidcStatus,
    retry: false,
  });
  const [linking, setLinking] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function begin(event: React.FormEvent) {
    event.preventDefault();
    if (!linking || !password || busy) return;
    const confirmation = password;
    setPassword("");
    setBusy(true);
    setFailed(false);
    try {
      const result = await linkOidc(linking, confirmation);
      redirectToOidc(result.authorizationUrl);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  if (status.isLoading)
    return <Text role="status">{t("Loading SSO settings…")}</Text>;
  if (status.isError)
    return (
      <Alert role="alert" color="red">
        <Text>
          {t(
            "Could not load SSO settings. A current interactive sign-in and supported workspace policy are required.",
          )}
        </Text>
        <Button variant="subtle" onClick={() => status.refetch()}>
          {t("Retry SSO status")}
        </Button>
      </Alert>
    );
  const data = status.data!;
  const linked = data.providers.some((provider) => provider.linked);
  return (
    <Stack gap="sm">
      <Title order={3} size="h4">
        {t("Single sign-on")}
      </Title>
      <Text size="sm">
        {t(
          "Optional OIDC sign-in for existing accounts. Linking requires your current password and confirmation at the identity provider.",
        )}
      </Text>
      {new URLSearchParams(window.location.search).get("oidc") === "linked" &&
        linked && (
          <Alert color="green" role="status">
            {t("Your SSO account is linked.")}
          </Alert>
        )}
      {!data.providers.length && (
        <Text size="sm" c="dimmed">
          {t("No SSO provider is enabled. Password login remains available.")}
        </Text>
      )}
      {data.providers.map((provider) => (
        <Stack
          key={provider.id}
          gap="xs"
          p="sm"
          style={{
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: 4,
          }}
        >
          <Text size="sm" style={{ overflowWrap: "anywhere" }}>
            {provider.issuer}
          </Text>
          <Group>
            {provider.linked && <Badge>{t("Linked")}</Badge>}
            {!provider.isEnabled && <Badge color="gray">{t("Disabled")}</Badge>}
            {provider.isEnabled && !provider.linked && (
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setLinking(provider.id);
                  setPassword("");
                  setFailed(false);
                }}
              >
                {t("Link account")}
              </Button>
            )}
          </Group>
        </Stack>
      ))}
      {linking && (
        <form onSubmit={begin}>
          <Stack gap="xs">
            <PasswordInput
              label={t("Current password to link SSO")}
              autoFocus
              visibilityToggleButtonProps={{
                tabIndex: 0,
                "aria-label": t("Show or hide SSO confirmation password"),
              }}
              autoComplete="current-password"
              required
              maxLength={1024}
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            {failed && (
              <Alert role="alert" color="red">
                {t(
                  "Could not start account linking. Sign in again and retry with your current password.",
                )}
              </Alert>
            )}
            <Group>
              <Button type="submit" loading={busy} disabled={!password || busy}>
                {t("Continue to identity provider")}
              </Button>
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() => {
                  setLinking("");
                  setPassword("");
                }}
              >
                {t("Cancel linking")}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
