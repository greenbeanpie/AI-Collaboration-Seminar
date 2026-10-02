import { projectPath, request, type RequestOptions } from './client';
import type { DataOf } from './types';

/** Uses the shared envelope/error/credential handling for the additive project APIs. */
export async function projectRequest<T>(projectId: string, tail: string, options: RequestOptions = {}): Promise<T> {
  return await request<'ProjectResponse'>(projectPath(projectId, tail), options) as unknown as T;
}
export async function accountRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return await request<'PersonalProfileResponse'>(path, options) as unknown as T;
}
export type ProjectGoal = { projectId: string; title: string; detail: string; revision: number; graphRevision: number };
export type ResourcePurpose = 'background' | 'reference' | 'output';
export type ResourceEntry = { resourceType: 'source' | 'material'; resourceId: string; title: string; purpose: ResourcePurpose; currentVersionId: string | null; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null; lifecycleVersion: number; fileId: string | null; canManage: boolean };
export const resourcePurposeLabels: Record<ResourcePurpose, string> = { background: '背景', reference: '参考', output: '成果' };
export type ProfileImportCandidate = { candidateId: string; sourceProjectId: string; sourceProjectName: string; major: string; skills: string[]; weeklyAvailableHours: number | null; importedAt: string | null; createdAt: string };
export type PersonalProfile = DataOf<'PersonalProfileResponse'> & { weeklyAvailableHours?: number | null };
export type ImportField = 'major' | 'specialties' | 'weeklyAvailableHours';
export type StandardCitation = { sourceVersionId: string; fragmentId: string; pageNumber: number | null; quote: string; availability?: string; deletedAt?: string | null };
export type StandardRequirement = { requirementId: string; requirementSetId: string; title: string; detail: string; category: 'deadline' | 'deliverable' | 'format' | 'scoring' | 'team' | 'other'; dueDate?: string | null; duePrecision?: 'date' | 'datetime' | 'unknown'; citations: StandardCitation[] };
export type StandardVersion = { standardsVersionId: string; projectId: string; version: number; title: string; status: 'draft' | 'confirmed'; revision: number; requirementSetIds: string[]; rubricVersionId: string; mappings: { requirementId: string; dimensionKey: string }[]; requirements: StandardRequirement[]; rubric: { rubricVersionId: string; version: number; weights: { key: string; label: string; weight: number }[]; notes: string | null }; confirmedAt: string | null; createdAt: string };
export type AssessmentEvidence = { type: 'material'; materialVersionId: string; quote: string } | { type: 'answer'; turnSequence: number; quote: string };
export type AssessmentReport = { kind: 'assistive'; status: 'scored' | 'unscorable'; scores: { key: string; label: string; score: number | null; confidence: string | number; comment: string; evidence: AssessmentEvidence[] }[]; weightedTotal: number | null; summary: string; limitations: string[]; requirementChecks: { requirementId: string; status: 'met' | 'unmet' | 'unknown'; comment: string; evidence: AssessmentEvidence[] }[] };
export type Assessment = { assessmentId: string; kind: 'material_review' | 'rehearsal'; status: string; goalRevision: number | null; goal: ProjectGoal | null; standardsVersionId: string | null; standardsVersion: number | null; materialVersionIds: string[]; rehearsalId: string | null; jobId?: string | null; jobError?: string | null; report: AssessmentReport | Record<string, unknown> | null; createdAt: string; historical: boolean };
export async function resourceLibrary(projectId: string, signal?: AbortSignal): Promise<ResourceEntry[]> {
  const items: ResourceEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { items: ResourceEntry[]; nextCursor: string | null } = await projectRequest(projectId, '/resource-library', { signal, query: { limit: 100, cursor } });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('资料列表返回重复游标，请刷新后重试。');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
