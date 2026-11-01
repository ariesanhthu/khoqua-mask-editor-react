import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { addPixelAudit, addPolygonFiles } from './polygon-export';

describe('independent polygon files', () => {
  it('does not export stale instances after a reset', async () => {
    const zip = new JSZip();
    await addPolygonFiles(zip, 'polygons/test', [{ type: 'POLYGON_SET', polygons: [] }, { type: 'RESET_TO_PREDICTION' }], 3, 3);
    expect(JSON.parse(await zip.file('polygons/test/index.json')!.async('string'))).toMatchObject({ vectorsCurrent: false, polygons: [] });
    expect(JSON.parse(await zip.file('polygons/test/coco.json')!.async('string')).annotations).toEqual([]);
  });
  it('reports a missing one-pixel line without changing either saved input', async () => {
    const polygon = { id:'line',label:'w1',nodes:[[1,0],[2,0],[2,5],[1,5]].map(([x,y],i)=>({id:String(i),x,y})) };
    const original = JSON.stringify(polygon);
    const mask = await sharp(new Uint8Array(15), { raw:{width:3,height:5,channels:1} }).png().toBuffer();
    const zip = new JSZip();
    await addPixelAudit(zip,'audit',[{type:'POLYGON_SET',polygons:[polygon]}],3,5,mask);
    expect(JSON.parse(await zip.file('audit/audit.json')!.async('string'))).toMatchObject({differentPixels:5,vectorOnly:5,savedOnly:0});
    expect(JSON.stringify(polygon)).toBe(original);
    const pixels = await sharp(await zip.file('audit/vector-mask.png')!.async('nodebuffer')).greyscale().raw().toBuffer();
    expect([...pixels]).toEqual([0,255,0,0,255,0,0,255,0,0,255,0,0,255,0]);
  });
  it('retains two overlapping instances with the same label, fractional nodes and a hole', async () => {
    const ring = (id: string, x: number, y: number, end: number) => [[x,y],[end,y],[end,end],[x,end]].map(([x,y],i)=>({id:`${id}${i}`,x,y}));
    const a = { id:'a',label:'w1',nodes:ring('a',0.25,0.25,9.75),holes:[ring('h',3.25,3.25,6.75)],meta:{locked:true} };
    const b = { id:'b',label:'w1',nodes:ring('b',4.25,4.25,8.75) };
    const zip = new JSZip();
    await addPolygonFiles(zip,'polygons/test',[{type:'POLYGON_SET',polygons:[a,b]}],10,10);
    const index = JSON.parse(await zip.file('polygons/test/index.json')!.async('string'));
    expect(index.polygons).toHaveLength(2);
    for (const [i, polygon] of [a,b].entries()) {
      const entry = index.polygons[i];
      expect(JSON.parse(await zip.file(`polygons/test/${entry.json}`)!.async('string')).polygon).toEqual(polygon);
      const {data,info}=await sharp(await zip.file(`polygons/test/${entry.mask}`)!.async('nodebuffer')).greyscale().raw().toBuffer({resolveWithObject:true});
      expect([info.width,info.height]).toEqual([10,10]);
      expect(data[5*10+5]).toBe(i===0?0:255);
      expect(data[7*10+7]).toBe(255); // both retain overlapping coverage independently
    }
    const labels = JSON.parse(await zip.file('polygons/test/instance-labels.json')!.async('string'));
    expect(labels.instances.map((item: { id: number; polygonId: string; label: string }) => [item.id, item.polygonId, item.label]))
      .toEqual([[1, 'a', 'w1'], [2, 'b', 'w1']]);
    const { data: instances, info: instanceInfo } = await sharp(await zip.file('polygons/test/instance-mask.png')!.async('nodebuffer'))
      .raw().toBuffer({ resolveWithObject: true });
    expect(instanceInfo.channels).toBe(3);
    const idAt = (x: number, y: number) => instances[(y * 10 + x) * 3] + 256 * instances[(y * 10 + x) * 3 + 1] + 65536 * instances[(y * 10 + x) * 3 + 2];
    expect(idAt(1, 1)).toBe(1);
    expect(idAt(5, 5)).toBe(2);
    expect(idAt(9, 0)).toBe(1);
    const boundaries = await sharp(await zip.file('polygons/test/boundaries.png')!.async('nodebuffer')).raw().toBuffer();
    expect(boundaries.some(value => value > 0)).toBe(true);
    const svg = await zip.file('polygons/test/vector-boundaries.svg')!.async('string');
    expect(svg).toContain('M3.25,3.25'); // original hole, independent of ID adjacency
    expect(svg).toContain('M4.25,4.25'); // overlapping instance still has its complete ring
    expect(svg).toContain('fill="none"');
    const coco = JSON.parse(await zip.file('polygons/test/coco.json')!.async('string'));
    expect(coco.annotations).toHaveLength(2);
    expect(coco.annotations[0].area).toBe(84);
    expect(coco.annotations[1].area).toBe(25);
  });
});
