import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import {
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from "lexical";
import { deleteSelectedMentionChip, type MentionDeletionDirection } from "./mention-deletion";

function handleMentionDelete(direction: MentionDeletionDirection, event: KeyboardEvent | null): boolean {
  const didDelete = deleteSelectedMentionChip(direction);
  if (!didDelete) return false;

  event?.preventDefault();
  event?.stopPropagation();
  return true;
}

export const mentionDeletionPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [
      (editor) =>
        editor.registerCommand(
          KEY_BACKSPACE_COMMAND,
          (event) => handleMentionDelete("backward", event as KeyboardEvent | null),
          COMMAND_PRIORITY_HIGH,
        ),
      (editor) =>
        editor.registerCommand(
          KEY_DELETE_COMMAND,
          (event) => handleMentionDelete("forward", event as KeyboardEvent | null),
          COMMAND_PRIORITY_HIGH,
        ),
    ]);
  },
});
