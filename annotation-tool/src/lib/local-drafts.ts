'use client';

import Dexie, { type EntityTable } from 'dexie';
import type { LocalDraft } from '@/types';

class AnnotationBrowserDatabase extends Dexie {
  drafts!: EntityTable<LocalDraft, 'key'>;

  constructor() {
    super('bitter-melon-annotation');
    this.version(1).stores({
      drafts: 'key, fileId, userId, updatedAt, syncState',
    });
  }
}

const browserDb = new AnnotationBrowserDatabase();

export function draftKey(projectId: string, fileId: string, userId: string) {
  return `${projectId}:${fileId}:${userId}`;
}

export async function getLocalDraft(projectId: string, fileId: string, userId: string) {
  return browserDb.drafts.get(draftKey(projectId, fileId, userId));
}

export async function putLocalDraft(draft: LocalDraft) {
  await browserDb.drafts.put(draft);
}

export async function updateLocalDraft(
  projectId: string,
  fileId: string,
  userId: string,
  changes: Partial<LocalDraft>,
) {
  await browserDb.drafts.update(draftKey(projectId, fileId, userId), changes);
}

export async function deleteLocalDraft(projectId: string, fileId: string, userId: string) {
  await browserDb.drafts.delete(draftKey(projectId, fileId, userId));
}

