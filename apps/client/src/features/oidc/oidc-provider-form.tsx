import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { configureOidc, OidcProvider } from "./oidc-service";

export function OidcProviderForm({
  provider,
  callbackUrl,
  onSaved,
  onCancel,
}: {
  provider?: OidcProvider;
  callbackUrl: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [issuer, setIssuer] = useState(provider?.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(provider?.isEnabled ?? false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !issuer || !clientId || !password || (!provider && !secret))
      return;
    const value = {
      id: provider?.id,
      issuer,
      clientId,
      clientSecret: secret || undefined,
      isEnabled: enabled,
      password,
    };
    setSaving(true);
    setFailed(false);
    setSecret("");
    setPassword("");
    try {
      await configureOidc(value);
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save}>
      <Stack gap="sm">
        <Text size="sm">
          {t(
            "Register this callback URL in your identity provider. The server must explicitly allow the issuer origin using WIKISAVVY_OIDC_ALLOWED_ORIGINS.",
          )}
        </Text>
        <Code block>{callbackUrl}</Code>
        <TextInput
          label={t("OIDC issuer")}
          autoFocus={!provider}
          type="url"
          required
          maxLength={2048}
          readOnly={Boolean(provider)}
          value={issuer}
          onChange={(event) => setIssuer(event.currentTarget.value)}
          disabled={saving}
        />
        <TextInput
          label={t("OIDC client identifier")}
          required
          maxLength={512}
          readOnly={Boolean(provider)}
          value={clientId}
          onChange={(event) => setClientId(event.currentTarget.value)}
          disabled={saving}
        />
        <PasswordInput
          label={t("OIDC client secret")}
          autoFocus={Boolean(provider)}
          visibilityToggleButtonProps={{
            tabIndex: 0,
            "aria-label": t("Show or hide OIDC client secret"),
          }}
          required={!provider}
          maxLength={8192}
          autoComplete="new-password"
          description={
            provider ? t("Leave empty to keep the stored secret.") : undefined
          }
          value={secret}
          onChange={(event) => setSecret(event.currentTarget.value)}
          disabled={saving}
        />
        <PasswordInput
          label={t("Current password to configure SSO")}
          visibilityToggleButtonProps={{
            tabIndex: 0,
            "aria-label": t("Show or hide SSO configuration password"),
          }}
          required
          maxLength={1024}
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          disabled={saving}
        />
        <Checkbox
          label={t("Enable optional SSO")}
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          disabled={saving}
        />
        <Text size="sm" c="dimmed">
          {t(
            "Password login stays available. Existing accounts must explicitly link before using SSO. Disabling a provider blocks new SSO sign-ins, not existing sessions.",
          )}
        </Text>
        {failed && (
          <Alert color="red" role="alert">
            {t(
              "Could not save SSO configuration. Check your password, server issuer allowlist and provider settings, then try again.",
            )}
          </Alert>
        )}
        <Group>
          <Button
            type="submit"
            loading={saving}
            disabled={
              saving ||
              !issuer ||
              !clientId ||
              !password ||
              (!provider && !secret)
            }
          >
            {t("Save SSO provider")}
          </Button>
          <Button variant="subtle" onClick={onCancel} disabled={saving}>
            {t("Cancel")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
