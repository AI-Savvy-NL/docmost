import "@/features/editor/styles/index.css";
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { templateExtensions } from "@/features/editor/extensions/extensions";
import {
  deleteTemplate,
  templateError,
  templateInfo,
  TemplateRecord,
  updateTemplate,
} from "./template-api";
import { TemplateDestination } from "./template-destination";

export default function TemplateDetail() {
  const { t } = useTranslation();
  const { templateId = "" } = useParams();
  const query = useQuery({
    queryKey: ["templates", templateId],
    queryFn: () => templateInfo(templateId),
    enabled: !!templateId,
    refetchOnWindowFocus: false,
  });
  if (query.isPending)
    return (
      <div role="status" aria-label={t("Loading template")}>
        <Loader />
      </div>
    );
  if (query.isError)
    return (
      <Alert role="alert" color="red">
        {templateError(query.error, t("Failed to load template"))}
        <Button onClick={() => void query.refetch()}>{t("Retry")}</Button>
        <Button component={Link} to="/templates" variant="subtle">
          {t("Back to templates")}
        </Button>
      </Alert>
    );
  return <TemplateForm key={templateId} template={query.data} />;
}

function TemplateForm({ template }: { template: TemplateRecord }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(template.title ?? "");
  const [description, setDescription] = useState(template.description ?? "");
  const [revision, setRevision] = useState(template.updatedAt);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [using, setUsing] = useState(false);
  const editor = useEditor({
    extensions: templateExtensions,
    content: template.content,
    editable: template.canManage,
    textDirection: "auto",
    editorProps: { attributes: { "aria-label": t("Template body") } },
    onUpdate: () => {
      setDirty(true);
      setSaved(false);
    },
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: updateTemplate,
    onSuccess: async (record) => {
      editor?.commands.setContent(record.content, { emitUpdate: false });
      setRevision(record.updatedAt);
      setDirty(false);
      setSaved(true);
      client.setQueryData(["templates", template.id], record);
      await client.invalidateQueries({ queryKey: ["templates", "workspace"] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["templates"] });
      navigate("/templates");
    },
  });
  useEffect(() => {
    editor?.setEditable(
      template.canManage && !save.isPending && !remove.isPending,
    );
  }, [editor, template.canManage, save.isPending, remove.isPending]);
  return (
    <Container size="lg" py="xl">
      <Stack>
        <Group justify="space-between">
          <Button
            component={Link}
            to="/templates"
            variant="subtle"
            onClick={(event) => {
              if (
                dirty &&
                !window.confirm(t("Discard unsaved template changes?"))
              )
                event.preventDefault();
            }}
          >
            {t("Back to templates")}
          </Button>
          <Button
            disabled={dirty || save.isPending}
            onClick={() => setUsing(true)}
          >
            {t("Use template")}
          </Button>
        </Group>
        {template.canManage ? (
          <>
            <TextInput
              label={t("Title")}
              maxLength={255}
              value={title}
              disabled={save.isPending}
              onChange={(event) => {
                setTitle(event.currentTarget.value);
                setDirty(true);
                setSaved(false);
              }}
            />
            <Textarea
              label={t("Description")}
              maxLength={2000}
              value={description}
              disabled={save.isPending}
              onChange={(event) => {
                setDescription(event.currentTarget.value);
                setDirty(true);
                setSaved(false);
              }}
            />
            <Text c="dimmed" size="sm">
              {t(
                "Edit the reusable snapshot below. To include uploaded files, create a snapshot from a page.",
              )}
            </Text>
          </>
        ) : (
          <>
            <Title order={1}>{template.title || t("Untitled")}</Title>
            {template.description && <Text>{template.description}</Text>}
          </>
        )}
        <Paper withBorder p="lg">
          <EditorContent editor={editor} />
        </Paper>
        {save.isError && (
          <Alert role="alert" color="red">
            {templateError(save.error, t("Failed to save template"))}
          </Alert>
        )}
        {saved && <Text role="status">{t("Saved")}</Text>}
        {dirty && (
          <Text size="sm" c="dimmed">
            {t("Unsaved changes")}
          </Text>
        )}
        {template.canManage && (
          <Group>
            <Button
              loading={save.isPending}
              disabled={!editor || remove.isPending}
              onClick={() => {
                if (editor)
                  save.mutate({
                    templateId: template.id,
                    title,
                    description,
                    content: editor.getJSON(),
                    expectedUpdatedAt: revision,
                  });
              }}
            >
              {t("Save template")}
            </Button>
            <Button
              variant="subtle"
              color="red"
              disabled={save.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              {t("Delete template")}
            </Button>
          </Group>
        )}
        <Modal
          opened={confirmDelete}
          onClose={() => {
            if (!remove.isPending) setConfirmDelete(false);
          }}
          title={t("Delete template")}
        >
          <Stack>
            <Text>
              {t(
                "Delete this workspace template? Pages already created from it will remain.",
              )}
            </Text>
            {remove.isError && (
              <Alert role="alert" color="red">
                {templateError(remove.error, t("Failed to delete template"))}
              </Alert>
            )}
            <Button
              color="red"
              loading={remove.isPending}
              onClick={() => remove.mutate(template.id)}
            >
              {t("Confirm delete")}
            </Button>
          </Stack>
        </Modal>
        <TemplateDestination
          template={using ? template : null}
          onClose={() => setUsing(false)}
        />
      </Stack>
    </Container>
  );
}
