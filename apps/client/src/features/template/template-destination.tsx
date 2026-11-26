import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DestinationPickerModal } from "@/components/ui/destination-picker/destination-picker-modal";
import { invalidateOnCreatePage } from "@/features/page/queries/page-query";
import { buildPageUrl } from "@/features/page/page.utils";
import { templateError, TemplateRecord, useTemplate } from "./template-api";

export function TemplateDestination({
  template,
  onClose,
  initialSpaceId,
}: {
  template: TemplateRecord | null;
  onClose: () => void;
  initialSpaceId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const mutation = useMutation({ mutationFn: useTemplate });
  return (
    <>
      <DestinationPickerModal
        error={error}
        opened={!!template}
        onClose={() => {
          if (!mutation.isPending) {
            setError("");
            onClose();
          }
        }}
        title={t("Choose destination")}
        actionLabel={t("Create page")}
        initialSpaceId={initialSpaceId}
        loading={mutation.isPending}
        onSelect={async (selection) => {
          if (!template || mutation.isPending) return;
          setError("");
          try {
            const page = await mutation.mutateAsync({
              templateId: template.id,
              spaceId: selection.spaceId,
              parentPageId:
                selection.type === "page" ? selection.pageId : undefined,
            });
            invalidateOnCreatePage(page);
            onClose();
            if (selection.space.slug && page.slugId) {
              navigate(
                buildPageUrl(selection.space.slug, page.slugId, page.title),
              );
            }
          } catch (error) {
            setError(
              templateError(error, t("Failed to create page from template")),
            );
          }
        }}
      />
    </>
  );
}
