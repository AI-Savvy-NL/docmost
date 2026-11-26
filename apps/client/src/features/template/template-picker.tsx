import { useState } from "react";
import { Alert, Modal, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { TemplateRecord, templateError } from "./template-api";
import { TemplateResults } from "./template-results";
import { TemplateDestination } from "./template-destination";

export default function TemplatePicker({
  opened,
  onClose,
  initialSpaceId,
  onUse,
}: {
  opened: boolean;
  onClose: () => void;
  initialSpaceId?: string;
  onUse?: (template: TemplateRecord) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<TemplateRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Modal
        opened={opened && !selected}
        onClose={() => {
          if (!pending) {
            setError("");
            onClose();
          }
        }}
        title={t("Templates")}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t("Choose a reusable workspace template")}
          </Text>
          {pending ? (
            <Text role="status">{t("Preparing template")}</Text>
          ) : (
            <TemplateResults
              onChoose={async (template) => {
                setError("");
                if (!onUse) {
                  setSelected(template);
                  return;
                }
                setPending(true);
                try {
                  await onUse(template);
                  onClose();
                } catch (error) {
                  setError(templateError(error, t("Failed to apply template")));
                } finally {
                  setPending(false);
                }
              }}
            />
          )}
          {error && (
            <Alert role="alert" color="red">
              {error}
            </Alert>
          )}
        </Stack>
      </Modal>
      <TemplateDestination
        template={selected}
        initialSpaceId={initialSpaceId}
        onClose={() => {
          setSelected(null);
          onClose();
        }}
      />
    </>
  );
}
