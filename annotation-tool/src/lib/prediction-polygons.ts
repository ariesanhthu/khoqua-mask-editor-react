import 'server-only';
import sharp from 'sharp';
import type { MaskOperation } from '@/types';
import { fetchDatasetAsset } from './drive-service';
import { vectorizeBinaryMask } from './mask-pixels';

/** The binary prediction is authoritative until a user modifies the segmentation. */
export async function loadPredictionPolygons(reference: string, width: number, height: number): Promise<MaskOperation[]> {
  const bytes = await fetchDatasetAsset(reference);
  const { data, info } = await sharp(bytes).flatten({ background: '#000000' }).greyscale().threshold(127).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error('Prediction dimensions do not match the source image');
  return [{ type: 'POLYGON_SET', polygons: vectorizeBinaryMask(data, width, height, 'prediction') }];
}
