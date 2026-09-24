import { z } from 'zod';
import { type ProductIntake } from './types.js';

const answer = z.object({
  status: z.enum(['confirmed', 'approved_estimate', 'not_applicable']),
  detail: z.string().trim().min(3).max(2000),
  source: z.enum(['user', 'reference', 'existing_scene']),
  evidence: z.string().trim().min(3).max(500),
}).refine(value => value.status !== 'approved_estimate' || value.source === 'user', '推估必须由用户明确允许')
  .refine(value => value.status !== 'not_applicable' || value.source === 'user', '不适用必须有用户依据');

export const intakeSchema = z.object({ fields: z.object({
  dimensions: answer.optional(), materials: answer.optional(), construction: answer.optional(),
  views: answer.optional(), artwork: answer.optional(), deliverable: answer.optional(),
}).refine(fields => Object.values(fields).some(Boolean), '至少填写一项') });

const questions: Record<keyof Required<ProductIntake>, string> = {
  dimensions: '请提供至少一个真实外形尺寸（含单位，以及是否含盖/底座）；若没有，是否明确允许用暂定尺寸按照片比例估算？',
  materials: '各可见部件分别是什么基材和表面工艺（例如玻璃、塑料、金属、纸张）？若无法确定，是否允许按实拍做视觉近似？',
  construction: '产品的分件、数量、开合方式及正背左右方向是什么？照片无法判断的关键结构请说明，或明确允许推估。',
  views: '现有照片是否覆盖建模需要的侧面、顶部、背面与打开状态？缺少的关键视角能否补拍，或明确允许推估？',
  artwork: '贴图各区域对应哪些实体面、文字朝向如何？若本轮不贴图，请明确说明。',
  deliverable: '本次要做模型、摄影场景还是成片？需要哪些视角、预览或正式图？',
};

export function intakeStatus(intake: ProductIntake = {}) {
  const missing = (Object.keys(questions) as Array<keyof ProductIntake>).flatMap(key => {
    const value = intake[key];
    if (!value) return [{ field: key, question: questions[key] }];
    if (['dimensions', 'materials'].includes(key) && value.status === 'not_applicable') return [{ field: key, question: questions[key] }];
    if (key === 'dimensions' && value.status === 'confirmed' && value.source === 'reference') return [{ field: key, question: questions[key] }];
    if (key === 'dimensions' && !/\d+(?:[.,]\d+)?\s*(?:mm|cm|m\b|毫米|厘米|米|in\b|inch|英寸)/i.test(value.detail)) return [{ field: key, question: questions[key] }];
    if (key === 'materials' && value.status === 'confirmed' && value.source === 'reference') return [{ field: key, question: questions[key] }];
    if (key === 'deliverable' && value.status === 'not_applicable') return [{ field: key, question: questions[key] }];
    return [];
  });
  return { readyForNewProduct: missing.length === 0, missing };
}

export function requireNewProductIntake(intake: ProductIntake = {}) {
  const status = intakeStatus(intake);
  if (status.readyForNewProduct) return;
  throw new Error(`新产品建模尚未完成资料确认。先查看已有实拍/贴图，把能确定的事实写入 record_intake；以下缺项请集中询问用户，并等待答复或明确授权推估后再调用建模工具：\n${status.missing.map(item => `- ${item.question}`).join('\n')}`);
}
