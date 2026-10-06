import { z } from 'zod';
import { AppError } from '../core/errors';
import { rubricWeightsSchema, rubricScoringSchema, type TaskEvaluation, type EvaluationRubricSnapshot } from './collaboration-ai-contracts';

export interface EvaluationMaterial {
    versionId: string;
    markdown: string;
    attachments: unknown[];
}
export function unreadMaterialReview(materials: EvaluationMaterial[]) {
    const reasonCodes: Array<'unread_attachments' | 'unread_references'> = [];
    const reasons: string[] = [];
    if (materials.some(m => m.attachments.length > 0)) {
        reasonCodes.push('unread_attachments');
        reasons.push('附件内容未读取，需要人工核对');
    }
    if (materials.some(m => /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:www\.|mailto:|data:|file:))|!?\[[^\]]*\]\s*(?:\(|\[)|^\s*\[[^\]]+\]:|<(?:img|iframe|video|audio|object|embed|source|a)\b/im.test(m.markdown)))
        {
            reasonCodes.push('unread_references');
            reasons.push('材料包含链接或图片引用，引用内容未读取');
        }
    return { reasonCodes, reasons };
}
export function assessEvidence(report: TaskEvaluation, materials: EvaluationMaterial[], includeUnreadReferences = true): string[] {
    const byId = new Map(materials.map(m => [m.versionId, m]));
    for (const evidence of [...report.evidence, ...(report.scores ?? []).flatMap(score => score.evidence)]) {
        const material = byId.get(evidence.materialVersionId);
        if (!material || !material.markdown.includes(evidence.quote))
            throw new AppError('AI_OUTPUT_INVALID', '评估引用的材料版本或原文证据无效', 502, false);
    }
    const reasons: string[] = [];
    if (!materials.length || materials.every(m => !m.markdown.trim()))
        reasons.push('没有可核对的材料正文');
    if (includeUnreadReferences) reasons.push(...unreadMaterialReview(materials).reasons);
    if (!report.evidence.length)
        reasons.push('评估没有提供材料原文证据');
    if (report.coverage !== 'complete')
        reasons.push('评估证据覆盖不完整');
    if (report.limitations.length)
        reasons.push(...report.limitations);
    if (report.scores?.some(score => score.confidence < 0.6))
        reasons.push('部分辅助评分置信度不足，需要人工核对');
    return [...new Set(reasons)];
}
export function buildAssistiveRubricScoring(report: TaskEvaluation, rubric: EvaluationRubricSnapshot | null): z.infer<typeof rubricScoringSchema> {
    if (!rubric||!rubric.weights.length) {
        if (report.scores) throw new AppError('AI_OUTPUT_INVALID', '当前生效项目标准没有评分维度，不允许生成分数', 502, false);
        return { kind: 'assistive', status: 'unavailable', reason: '当前生效项目标准没有评分维度，本次仅提供成果反馈' };
    }
    const keys = new Set(report.scores?.map(score => score.key));
    if (!report.scores || keys.size !== rubric.weights.length || report.scores.length !== rubric.weights.length || rubric.weights.some(weight => !keys.has(weight.key)))
        throw new AppError('AI_OUTPUT_INVALID', '辅助评分必须且只能覆盖全部已确认评分维度', 502, false);
    const byKey = new Map(report.scores.map(score => [score.key, score]));
    const scores = rubric.weights.map(weight => byKey.get(weight.key)!);
    const weightedTotal = calculateRubricWeightedTotal(rubric.weights, scores);
    return { kind: 'assistive', status: 'scored', ...(rubric.standardsVersionId?{standardsVersionId:rubric.standardsVersionId}:{}), rubricVersionId: rubric.rubricVersionId, rubricVersion: rubric.version, weights: rubric.weights, weightedTotal, scores };
}
/** Shared by assistive output and explicit owner score overrides; never accepts model totals. */
export function calculateRubricWeightedTotal(weights: EvaluationRubricSnapshot['weights'], scores: Array<{ key: string; score: number }>): number {
    const parsedWeights = rubricWeightsSchema.safeParse(weights);
    const parsedScores = z.array(z.object({ key: z.string().min(1).max(40), score: z.number().min(0).max(100) })).min(1).max(10).safeParse(scores);
    if (!parsedWeights.success || !parsedScores.success) throw new AppError('VALIDATION_FAILED', '辅助评分维度、分数或权重无效', 400, false);
    const byKey = new Map(parsedScores.data.map(score => [score.key, score.score]));
    if (byKey.size !== scores.length || scores.length !== weights.length || weights.some(weight => !byKey.has(weight.key))) throw new AppError('VALIDATION_FAILED', '辅助评分必须且只能覆盖全部已确认评分维度', 400, false);
    const totalWeight = weights.reduce((total, weight) => total + weight.weight, 0);
    return Math.round(weights.reduce((total, weight) => total + weight.weight * byKey.get(weight.key)!, 0) / totalWeight * 100) / 100;
}
