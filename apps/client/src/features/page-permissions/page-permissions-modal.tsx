import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PagePermissionError,
  PagePermissionState,
  PermissionGrant,
} from "./page-permission-api";
import {
  usePagePermissionState,
  usePermissionPrincipals,
  useSavePagePermissions,
} from "./page-permission-query";

const denied = (error: unknown) =>
  error instanceof PagePermissionError &&
  [401, 403, 404].includes(error.status);
const principalKey = (principal: { type: string; id: string }) =>
  `${principal.type}:${principal.id}`;
const grantState = (grants: PermissionGrant[]) =>
  JSON.stringify(
    grants
      .map(({ type, id, role }) => ({ type, id, role }))
      .sort((a, b) => principalKey(a).localeCompare(principalKey(b))),
  );

export default function PagePermissionsModal({
  pageId,
  opened,
  onClose,
}: {
  pageId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const query = usePagePermissionState(pageId, opened);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    const result = await query.refetch();
    if (result.isSuccess) setGeneration((value) => value + 1);
  };
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("Page permissions")}
      size="lg"
      withCloseButton={!busy}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
    >
      {opened &&
        (query.isPending ? (
          <Text role="status">{t("Loading page permissions…")}</Text>
        ) : query.isError ? (
          <Stack>
            <Alert color="red" role="alert">
              {denied(query.error)
                ? t("You no longer have permission to manage this page.")
                : t(
                    "Page permissions are unavailable. No changes were confirmed.",
                  )}
            </Alert>
            <Button
              variant="default"
              onClick={reload}
              loading={query.isFetching}
            >
              {t("Reload permissions")}
            </Button>
          </Stack>
        ) : (
          query.data && (
            <PermissionEditor
              key={`${pageId}:${generation}`}
              state={query.data}
              onClose={onClose}
              onReload={reload}
              onBusy={setBusy}
            />
          )
        ))}
    </Modal>
  );
}

function PermissionEditor({
  state,
  onClose,
  onReload,
  onBusy,
}: {
  state: PagePermissionState;
  onClose: () => void;
  onReload: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [base] = useState(state);
  const [draft, setDraft] = useState(state.grants);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failure, setFailure] = useState("");
  const [accessLost, setAccessLost] = useState(false);
  const mutation = useSavePagePermissions(state.pageId, base.revision, onClose);
  useEffect(() => {
    onBusy(mutation.isPending);
    return () => onBusy(false);
  }, [mutation.isPending, onBusy]);
  const changed = state.revision !== base.revision;
  const blocked = mutation.isPending || changed || Boolean(failure);
  const canSet = base.hasDirectRestriction || state.canCreateRestriction;
  const save = async (grants: PermissionGrant[] | null) => {
    try {
      await mutation.mutateAsync(grants);
    } catch (error) {
      const status =
        error instanceof PagePermissionError ? error.status : undefined;
      if ([401, 403].includes(status)) {
        setDraft([]);
        setAccessLost(true);
        setFailure(
          base.hasDirectRestriction
            ? t("You no longer have permission to manage this page.")
            : t(
                "This change is no longer allowed. Reload permissions to check your access and license.",
              ),
        );
      } else {
        setFailure(
          status === 409
            ? t(
                "Permissions changed or a page would lose its last writer. Reload and review your changes.",
              )
            : t(
                "Page permissions could not be saved. No changes were confirmed. Reload before trying again.",
              ),
        );
      }
    }
  };
  const conflict = t(
    "Permissions changed or a page would lose its last writer. Reload and review your changes.",
  );
  return (
    <Stack>
      {(failure || changed) && (
        <Alert color="red" role="alert">
          {failure || conflict}
        </Alert>
      )}
      {(failure || changed) && (
        <Button variant="default" onClick={onReload}>
          {t("Reload permissions")}
        </Button>
      )}
      {!accessLost && (
        <>
          <Text>
            {base.hasDirectRestriction
              ? t("This page has a direct restriction.")
              : base.inheritedPageId
                ? t("This page inherits restrictions from an ancestor.")
                : t("This page currently uses space permissions.")}
          </Text>
          {base.inheritedPageId && (
            <Text size="sm" c="dimmed">
              {t(
                "Access through restricted ancestors is always required. Grants here do not bypass them.",
              )}
            </Text>
          )}
          {!canSet && (
            <Alert>
              {t(
                "A valid WikiSavvy license is required to add a direct restriction.",
              )}
            </Alert>
          )}
          {canSet && (
            <>
              <Text size="sm" c="dimmed">
                {t(
                  "Space membership is required. At least one active member must retain write access, including on affected restricted descendants.",
                )}
              </Text>
              <Text size="sm" c="dimmed">
                {t("Removing your own access can close this page.")}
              </Text>
              {draft.length === 0 && (
                <Text>{t("No direct grants selected.")}</Text>
              )}
              {draft.map((grant) => (
                <Group key={principalKey(grant)} align="end" wrap="nowrap">
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text truncate>{grant.name}</Text>
                    <Text size="xs" c="dimmed">
                      {grant.type === "group" ? t("Group") : grant.email}
                    </Text>
                  </Stack>
                  <NativeSelect
                    label={t("Role")}
                    aria-label={t("Role for {{name}}", { name: grant.name })}
                    value={grant.role}
                    disabled={blocked}
                    data={[
                      { value: "reader", label: t("Reader") },
                      { value: "writer", label: t("Writer") },
                    ]}
                    onChange={(event) => {
                      const role = event.currentTarget
                        .value as PermissionGrant["role"];
                      setDraft((current) =>
                        current.map((entry) =>
                          principalKey(entry) === principalKey(grant)
                            ? { ...entry, role }
                            : entry,
                        ),
                      );
                    }}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t("Remove {{name}}", { name: grant.name })}
                    disabled={blocked}
                    onClick={() =>
                      setDraft((current) =>
                        current.filter(
                          (entry) =>
                            principalKey(entry) !== principalKey(grant),
                        ),
                      )
                    }
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
              <PrincipalPicker
                pageId={state.pageId}
                selected={draft}
                disabled={blocked}
                onDenied={() => {
                  setDraft([]);
                  setAccessLost(true);
                  setFailure(
                    t("You no longer have permission to manage this page."),
                  );
                }}
                onAdd={(principal) =>
                  setDraft((current) => [
                    ...current,
                    { ...principal, role: "reader" },
                  ])
                }
              />
              <Group justify="end">
                <Button
                  variant="default"
                  onClick={onClose}
                  disabled={mutation.isPending}
                >
                  {t("Cancel")}
                </Button>
                <Button
                  loading={mutation.isPending}
                  disabled={
                    blocked ||
                    !draft.some((grant) => grant.role === "writer") ||
                    (base.hasDirectRestriction &&
                      grantState(base.grants) === grantState(draft))
                  }
                  onClick={() =>
                    save(
                      draft.map(({ type, id, role }) => ({ type, id, role })),
                    )
                  }
                >
                  {base.hasDirectRestriction
                    ? t("Save permissions")
                    : t("Restrict page")}
                </Button>
              </Group>
            </>
          )}
          {base.hasDirectRestriction &&
            (confirmRemove ? (
              <Alert color="orange" role="alert">
                <Stack>
                  <Text>
                    {base.inheritedPageId
                      ? t(
                          "Removing this direct restriction keeps inherited restrictions in place.",
                        )
                      : t(
                          "Removing this restriction returns the page to space permissions. This can broaden access.",
                        )}
                  </Text>
                  <Group>
                    <Button
                      color="red"
                      disabled={blocked}
                      onClick={() => save(null)}
                    >
                      {t("Remove direct restriction")}
                    </Button>
                    <Button
                      variant="default"
                      disabled={mutation.isPending}
                      onClick={() => setConfirmRemove(false)}
                    >
                      {t("Keep restriction")}
                    </Button>
                  </Group>
                </Stack>
              </Alert>
            ) : (
              <Button
                variant="subtle"
                color="red"
                disabled={blocked}
                onClick={() => setConfirmRemove(true)}
              >
                {t("Remove restriction…")}
              </Button>
            ))}
        </>
      )}
    </Stack>
  );
}

function PrincipalPicker({
  pageId,
  selected,
  disabled,
  onAdd,
  onDenied,
}: {
  pageId: string;
  selected: Array<PermissionGrant>;
  disabled: boolean;
  onAdd: (principal: PagePermissionState["grants"][number]) => void;
  onDenied: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search, 250);
  const [value, setValue] = useState("");
  const principals = usePermissionPrincipals(pageId, query);
  useEffect(() => {
    if (denied(principals.error)) onDenied();
  }, [principals.error, onDenied]);
  const available = (principals.data ?? []).filter(
    (entry) =>
      !selected.some((grant) => principalKey(grant) === principalKey(entry)),
  );
  return (
    <Stack gap="xs">
      <TextInput
        label={t("Find people or groups")}
        value={search}
        maxLength={100}
        disabled={disabled}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {principals.isPending && (
        <Text role="status">{t("Loading people and groups…")}</Text>
      )}
      {principals.isError ? (
        <Alert color="red" role="alert">
          {t("People and groups could not be loaded.")}
        </Alert>
      ) : (
        <Group align="end">
          <NativeSelect
            label={t("Person or group")}
            value={value}
            disabled={disabled || principals.isPending}
            style={{ flex: 1 }}
            data={[
              { value: "", label: t("Choose a person or group") },
              ...available.map((entry) => ({
                value: principalKey(entry),
                label:
                  entry.type === "group"
                    ? `${entry.name} (${t("Group")})`
                    : entry.name,
              })),
            ]}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <Button
            variant="default"
            disabled={
              disabled ||
              !available.some((entry) => principalKey(entry) === value)
            }
            onClick={() => {
              const principal = available.find(
                (entry) => principalKey(entry) === value,
              );
              if (principal) onAdd({ ...principal, role: "reader" });
              setValue("");
            }}
          >
            {t("Add")}
          </Button>
        </Group>
      )}
      {!principals.isPending &&
        !principals.isError &&
        available.length === 0 && (
          <Text size="sm">{t("No matching people or groups.")}</Text>
        )}
    </Stack>
  );
}
