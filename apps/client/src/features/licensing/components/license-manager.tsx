import { useState } from "react";
import {
  Alert,
  Button,
  FileButton,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import { UserRole } from "@/lib/types.ts";
import { useWikisavvyLicense } from "../queries/license-query.ts";

export default function LicenseManager() {
  const { t } = useTranslation();
  const { data: currentUser, isPending: userLoading } = useCurrentUser();
  const isOwner = currentUser?.user?.role === UserRole.OWNER;
  const { data, isPending, isError, refetch, activate, remove } =
    useWikisavvyLicense(currentUser?.user?.workspaceId, isOwner);
  const [license, setLicense] = useState("");
  const [error, setError] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const busy = activate.isPending || remove.isPending;

  if (userLoading) return <Text>{t("Loading license status…")}</Text>;
  if (!isOwner)
    return (
      <Text c="dimmed">
        {t("Only workspace owners can manage WikiSavvy licenses.")}
      </Text>
    );
  if (isPending) return <Text>{t("Loading license status…")}</Text>;
  if (isError || !data)
    return (
      <Alert color="yellow">
        <Text>
          {t("License status is unavailable. No licensing changes were made.")}
        </Text>
        <Button variant="subtle" onClick={() => refetch()}>
          {t("Retry")}
        </Button>
      </Alert>
    );
  const labels = {
    community: "Community — no license",
    valid: "Valid",
    grace: "Renewal grace period",
    expired: "Expired — Community mode",
    invalid: "License could not be verified",
    "not-yet-valid": "License not active yet",
  };

  async function install() {
    setError("");
    try {
      await activate.mutateAsync(license.trim());
      setLicense("");
    } catch {
      setError(
        "License could not be installed. Check its workspace, validity and trusted issuer.",
      );
    } finally {
      activate.reset();
    }
  }
  async function removeLicense() {
    setError("");
    try {
      await remove.mutateAsync();
      setConfirmRemoval(false);
    } catch {
      setError(
        "License removal could not be confirmed. Refresh status before retrying.",
      );
    } finally {
      remove.reset();
    }
  }
  async function readFile(file: File | null) {
    setError("");
    if (!file) return;
    if (file.size > 32770) {
      setError("License file is too large.");
      return;
    }
    try {
      const value = (await file.text()).trim();
      if (value.length > 32768) throw new Error();
      setLicense(value);
    } catch {
      setError("License file could not be read.");
    }
  }

  return (
    <Stack gap="sm">
      <Title order={2} size="h4">
        {t("WikiSavvy license")}
      </Title>
      <Text>{t(labels[data.status])}</Text>
      <Text>
        {t("Workspace ID")}:{" "}
        <Text component="span" ff="monospace">
          {data.workspaceId}
        </Text>
      </Text>
      <Text>
        {t("Seats")}: {data.seats.active} / {data.seats.limit ?? t("Unlimited")}
      </Text>
      {data.status === "grace" && (
        <Alert color="yellow">
          {t(
            "Renew within the 30-day grace period to keep licensed capabilities available.",
          )}
        </Alert>
      )}
      {data.seats.overLimit && (
        <Alert color="yellow">
          {t(
            "Seat limit exceeded. Existing members are kept; additional activations are blocked while the license is active.",
          )}
        </Alert>
      )}
      {data.license && (
        <Stack gap={4}>
          <Text>
            {t("Licensed to")}: {data.license.licensee}
          </Text>
          <Text>
            {t("License ID")}: {data.license.licenseId}
          </Text>
          <Text>
            {t("Issued (UTC)")}: {data.license.issuedAt}
          </Text>
          <Text>
            {t("Valid from (UTC)")}: {data.license.notBefore}
          </Text>
          <Text>
            {t("Expires (UTC)")}: {data.license.expiresAt}
          </Text>
          <Text>
            {t("Grace ends (UTC)")}: {data.license.graceEndsAt}
          </Text>
          <Text>
            {t("Requested capabilities")}:{" "}
            {data.license.capabilities.join(", ") || t("None")}
          </Text>
        </Stack>
      )}
      {!data.implementedCapabilities.length && (
        <Alert color="blue">
          {t("No Enterprise capabilities are implemented in this build yet.")}
        </Alert>
      )}
      <Text size="sm">
        {t(
          "Licensing does not delete your content or disable existing security restrictions.",
        )}
      </Text>
      {!data.trustConfigured && (
        <Alert color="yellow">
          {t(
            "No trusted issuer public keys are configured. Ask the operator to configure the public-key file.",
          )}
        </Alert>
      )}
      {error && (
        <Alert color="red" role="alert">
          {t(error)}
        </Alert>
      )}
      <PasswordInput
        label={t("License")}
        value={license}
        autoComplete="off"
        maxLength={32768}
        onChange={(event) => setLicense(event.currentTarget.value)}
        disabled={busy}
      />
      <Group>
        <Button
          onClick={install}
          loading={activate.isPending}
          disabled={busy || !license.trim() || !data.trustConfigured}
        >
          {t(data.license ? "Update license" : "Install license")}
        </Button>
        <FileButton onChange={readFile} accept=".license,.txt">
          {(props) => (
            <Button {...props} variant="default" disabled={busy}>
              {t("Upload license file")}
            </Button>
          )}
        </FileButton>
        {(data.license || data.status === "invalid") && (
          <Button
            color="red"
            variant="subtle"
            disabled={busy}
            onClick={() => setConfirmRemoval(true)}
          >
            {t("Remove license")}
          </Button>
        )}
      </Group>
      {confirmRemoval && (
        <Alert color="yellow">
          <Text>
            {t(
              "Remove this license and return to Community mode? Your content and security restrictions will be preserved.",
            )}
          </Text>
          <Group mt="sm">
            <Button
              color="red"
              loading={remove.isPending}
              disabled={busy}
              onClick={removeLicense}
            >
              {t("Confirm removal")}
            </Button>
            <Button
              variant="default"
              disabled={busy}
              onClick={() => setConfirmRemoval(false)}
            >
              {t("Cancel")}
            </Button>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
