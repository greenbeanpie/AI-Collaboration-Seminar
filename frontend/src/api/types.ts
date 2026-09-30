import type { components } from './openapi';

export type SchemaName = keyof components['schemas'];
export type DataOf<Name extends SchemaName> = components['schemas'][Name] extends { data: infer Data } ? Data : never;

export type User = DataOf<'AuthSessionGetResponse'>['user'];
export type Project = DataOf<'ProjectResponse'>;
export type ProjectSummary = DataOf<'ProjectListResponse'>['items'][number];
export type Member = DataOf<'MemberListResponse'>['items'][number];
export type Capability = DataOf<'CapabilitiesResponse'>;
export type Task = DataOf<'TaskResponse'>;
export type Material = DataOf<'MaterialResponse'>;
export type MaterialVersion = DataOf<'MaterialVersionResponse'>;
export type Source = DataOf<'SourceListResponse'>['items'][number];
export type RequirementSet = DataOf<'RequirementSetListResponse'>['items'][number];
export type Job = DataOf<'JobResponse'>;
export type Review = DataOf<'ReviewResponse'>;
export type Rehearsal = DataOf<'RehearsalResponse'>;
export type EventItem = DataOf<'EventListResponse'>['items'][number];
export type Invitation = DataOf<'InvitationListResponse'>['items'][number];
export type Comment = DataOf<'CommentListResponse'>['items'][number];
export type Decision = DataOf<'DecisionListResponse'>['items'][number];
export type Contribution = DataOf<'ContributionListResponse'>['items'][number];
export type Resource = DataOf<'ResourceListResponse'>['items'][number];

export type ApiEnvelope<T> = { data: T; requestId: string };
export type ApiFailure = {
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  requestId: string;
};
