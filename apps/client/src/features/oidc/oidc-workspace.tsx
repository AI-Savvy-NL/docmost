import { useState } from "react";
import { Alert, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getOidcStatus, OidcProvider } from "./oidc-service";
import { OidcProviderForm } from "./oidc-provider-form";

export function OidcWorkspace() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ["oidc", "account"],
    queryFn: getOidcStatus,
    retry: false,
  });
  const [editing, setEditing] = useState<OidcProvider | null | undefined>();
  const [saved, setSaved] = useState(false);
  if (status.isLoading)
    return <Text role="status">{t("Loading SSO settings…")}</Text>;
  if (status.isError)
    return (
      <Alert role="alert" color="red">
        <Text>{t("Could not load SSO settings. Sign in again or retry.")}</Text>
        <Button variant="subtle" onClick={() => status.refetch()}>
          {t("Retry SSO status")}
        </Button>
      </Alert>
    );
  const data = status.data!;
  if (!data.canManage)
    return (
      <Text>{t("Only the workspace owner can manage SSO providers.")}</Text>
    );
  return (
    <Stack gap="sm">
      <Text size="sm">
        {t(
          "Manage optional OIDC sign-in here. Members link their own accounts in Profile. Password login remains available.",
        )}
      </Text>
      {saved && (
        <Alert color="green" role="status">
          {t("SSO provider saved.")}
        </Alert>
      )}
      {!data.providers.length && (
        <Text size="sm" c="dimmed">
          {t("No OIDC provider is configured.")}
        </Text>
      )}
      {data.providers.map((provider) => (
        <Group key={provider.id} justify="space-between">
          <Text size="sm" style={{ overflowWrap: "anywhere" }}>
            {provider.issuer}
          </Text>
          <Group>
            <Badge color={provider.isEnabled ? "blue" : "gray"}>
              {provider.isEnabled ? t("Enabled") : t("Disabled")}
            </Badge>
            <Button
              variant="subtle"
              size="xs"
              disabled={editing !== undefined}
              onClick={() => {
                setEditing(provider);
                setSaved(false);
              }}
            >
              {t("Edit SSO provider")}
            </Button>
          </Group>
        </Group>
      ))}
      {editing === undefined && (
        <Button
          variant="outline"
          onClick={() => {
            setEditing(null);
            setSaved(false);
          }}
        >
          {t("Configure SSO provider")}
        </Button>
      )}
      {editing !== undefined && (
        <OidcProviderForm
          key={editing?.id ?? "new"}
          provider={editing ?? undefined}
          callbackUrl={data.callbackUrl}
          onCancel={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setSaved(true);
            void status.refetch();
          }}
        />
      )}
    </Stack>
  );
}
