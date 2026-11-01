import { describe, expect, it } from 'vitest';
import { PolygonDraft } from './polygon-draft';

const node = (id: string, x = Number(id.slice(1)) * 10, y = 0) => ({ id, x, y });
const ids = (draft: PolygonDraft) => draft.nodes.map((item) => item.id);

describe('polygon draft point history', () => {
  it('undoes the most recently placed point one at a time and redoes them in order', () => {
    const draft = new PolygonDraft();
    for (let i = 1; i <= 6; i += 1) draft.add(node(`p${i}`));
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(draft.historyState(5, 0)).toEqual({ local: true, canUndo: true, canRedo: false });

    expect(draft.undo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(draft.undo()).toBe('draft');
    expect(draft.undo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3']);
    expect(draft.historyState(5, 0)).toEqual({ local: true, canUndo: true, canRedo: true });

    expect(draft.redo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4']);
    // A new point after undo drops the remaining redo branch.
    draft.add(node('q1'));
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4', 'q1']);
    expect(draft.redo()).toBe('blocked');
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4', 'q1']);
  });

  it('hands over to the global history only after every point was undone', () => {
    const draft = new PolygonDraft();
    draft.add(node('p1'));
    draft.add(node('p2'));
    expect(draft.undo()).toBe('draft');
    expect(draft.undo()).toBe('draft');
    expect(draft.nodes).toEqual([]);
    // Empty draft: the toolbar shows global history again, but the point redo still works.
    expect(draft.historyState(3, 1)).toEqual({ local: false, canUndo: true, canRedo: true });
    expect(draft.redo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1']);
    expect(draft.undo()).toBe('draft');
    expect(draft.undo()).toBe('global');
    expect(draft.editing).toBe(false);
    expect(draft.historyState(3, 1)).toEqual({ local: false, canUndo: true, canRedo: true });
    expect(draft.historyState(0, 0)).toEqual({ local: false, canUndo: false, canRedo: false });
    // Not editing: undo/redo always belong to the global history.
    expect(draft.redo()).toBe('global');
  });

  it('makes right-click point removal undoable without touching other points', () => {
    const draft = new PolygonDraft();
    ['p1', 'p2', 'p3', 'p4'].forEach((id) => draft.add(node(id)));
    expect(draft.remove('missing')).toBe(false);
    expect(draft.remove('p2')).toBe(true);
    expect(ids(draft)).toEqual(['p1', 'p3', 'p4']);
    expect(draft.undo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(draft.redo()).toBe('draft');
    expect(ids(draft)).toEqual(['p1', 'p3', 'p4']);
  });

  it('drops the duplicated vertex of a double-click without adding it to redo', () => {
    const draft = new PolygonDraft();
    ['p1', 'p2', 'p3'].forEach((id) => draft.add(node(id)));
    draft.add(node('p4'));
    draft.add(node('p4-dup', 40));
    draft.dropDoubleClickDuplicate();
    expect(ids(draft)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(draft.historyState(0, 0).canRedo).toBe(false);
    const single = new PolygonDraft();
    single.add(node('p1'));
    single.dropDoubleClickDuplicate();
    expect(ids(single)).toEqual(['p1']);
  });

  it('replaces the node array on every change and clears completely', () => {
    const draft = new PolygonDraft();
    draft.add(node('p1'));
    const before = draft.nodes;
    draft.add(node('p2'));
    expect(draft.nodes).not.toBe(before);
    expect(before.map((item) => item.id)).toEqual(['p1']);
    draft.clear();
    expect(draft).toMatchObject({ nodes: [], editing: false });
    expect(draft.undo()).toBe('global');
    expect(draft.historyState(0, 0)).toEqual({ local: false, canUndo: false, canRedo: false });
  });
});
