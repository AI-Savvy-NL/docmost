import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Container,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role";
import { DestinationPickerModal } from "@/components/ui/destination-picker/destination-picker-modal";
import { createTemplate, templateError } from "./template-api";
import { TemplateResults } from "./template-results";

export default function TemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { isAdmin } = useUserRole();
  const [opened, setOpened] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const mutation = useMutation({
    mutationFn: createTemplate,
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["templates"] });
      setOpened(false);
      navigate(`/templates/${created.id}`);
    },
  });
  return (
    <Container size="lg" py="xl">
      <Stack>
        <Group justify="space-between">
          <Title order={2}>{t("Templates")}</Title>
          <Button
            onClick={() => {
              setTitle("");
              setSource(null);
              setConfirmed(false);
              setSourceError("");
              mutation.reset();
              setOpened(true);
            }}
          >
            {t("New template")}
          </Button>
        </Group>
        <Text c="dimmed">
          {t(
            "Reusable workspace snapshots. Deleting a source page does not delete its template.",
          )}
        </Text>
        <TemplateResults
          onChoose={(template) => navigate(`/templates/${template.id}`)}
        />
        <Modal
          opened={opened && !choosing}
          onClose={() => {
            if (!mutation.isPending) setOpened(false);
          }}
          title={t("New template")}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate({
                title: title || undefined,
                sourcePageId: source?.id,
                confirmRestrictedSource: isAdmin && confirmed,
              });
            }}
          >
            <Stack>
              <TextInput
                label={t("Title")}
                value={title}
                maxLength={255}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              <Button variant="default" onClick={() => setChoosing(true)}>
                {t("Choose source page")}
              </Button>
              {source && (
                <>
                  <Text size="sm">
                    {t("Snapshot source")}: {source.title}
                  </Text>
                  <Button
                    variant="subtle"
                    onClick={() => {
                      setSource(null);
                      setConfirmed(false);
                    }}
                  >
                    {t("Use a blank template instead")}
                  </Button>
                  {isAdmin && (
                    <Checkbox
                      checked={confirmed}
                      onChange={(event) =>
                        setConfirmed(event.currentTarget.checked)
                      }
                      label={t(
                        "Publish restricted source content to every workspace member",
                      )}
                    />
                  )}
                </>
              )}
              <Text size="sm" c="dimmed">
                {t(
                  "Members can snapshot workspace-readable pages. Restricted sources require explicit admin confirmation. Uploaded files are copied independently.",
                )}
              </Text>
              {mutation.isError && (
                <Alert role="alert" color="red">
                  {templateError(
                    mutation.error,
                    t("Failed to create template"),
                  )}
                </Alert>
              )}
              <Button type="submit" loading={mutation.isPending}>
                {t("Create template")}
              </Button>
            </Stack>
          </form>
        </Modal>
        <DestinationPickerModal
          error={sourceError}
          opened={choosing}
          onClose={() => setChoosing(false)}
          title={t("Choose source page")}
          actionLabel={t("Select page")}
          onSelect={(selection) => {
            if (selection.type !== "page") {
              setSourceError(t("Select a page, not a space"));
              return;
            }
            const pageTitle = selection.page.title || t("Untitled");
            setSource({ id: selection.pageId, title: pageTitle });
            if (!title) setTitle(pageTitle);
            setConfirmed(false);
            setSourceError("");
            setChoosing(false);
          }}
        />
      </Stack>
    </Container>
  );
}
