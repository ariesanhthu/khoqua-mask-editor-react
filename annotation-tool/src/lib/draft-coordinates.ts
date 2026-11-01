import type { EditorBootstrap, LocalDraft } from '@/types';

export function draftFitsImage(draft: LocalDraft, data: EditorBootstrap): boolean {
  const space = draft.coordinateSpace;
  if (!space) return draft.baseServerRevision === (data.annotation?.revision ?? 0);
  return space.width === data.file.width && space.height === data.file.height && space.imageUrl === data.assets.imageUrl;
}
