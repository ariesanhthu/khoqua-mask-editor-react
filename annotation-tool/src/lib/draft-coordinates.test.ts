import { describe, expect, it } from 'vitest';
import { draftFitsImage } from './draft-coordinates';
import type { EditorBootstrap, LocalDraft } from '@/types';

describe('draft coordinate safety', () => {
  const data = { file:{width:200,height:100},assets:{imageUrl:'/image?v=drive'},annotation:{revision:7} } as EditorBootstrap;
  it('rejects notebook drafts with a different crop or image, even at the same size', () => {
    expect(draftFitsImage({coordinateSpace:{width:200,height:100,imageUrl:'/image?v=notebook'}} as LocalDraft,data)).toBe(false);
    expect(draftFitsImage({coordinateSpace:{width:1200,height:600,imageUrl:'/image?v=drive'}} as LocalDraft,data)).toBe(false);
    expect(draftFitsImage({coordinateSpace:{width:200,height:100,imageUrl:'/image?v=drive'}} as LocalDraft,data)).toBe(true);
  });
  it('permits a legacy draft only while its server revision is unchanged', () => {
    expect(draftFitsImage({baseServerRevision:7} as LocalDraft,data)).toBe(true);
    expect(draftFitsImage({baseServerRevision:6} as LocalDraft,data)).toBe(false);
  });
});
