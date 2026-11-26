import type { Editor } from "@tiptap/core";

export function applyPreparedTemplate(
  editor: Editor,
  titleEditor: Editor,
  template: { title: string; content: any },
): boolean {
  if (
    !editor ||
    editor.isDestroyed ||
    !editor.isEmpty ||
    !titleEditor ||
    titleEditor.isDestroyed
  )
    return false;
  editor.commands.setContent(template.content);
  if (titleEditor.isEmpty && template.title) {
    titleEditor.commands.insertContent({ type: "text", text: template.title });
  }
  return true;
}
