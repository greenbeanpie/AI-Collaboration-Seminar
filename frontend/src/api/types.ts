import type { components } from './openapi';

export type SchemaName = keyof components['schemas'];
export type DataOf<Name extends SchemaName> = components['schemas'][Name] extends { data: infer Data } ? Data : never;

export type User = Omit<DataOf<'AuthSessionGetResponse'>['user'], 'email' | 'username' | 'isAdmin' | 'role'> & { email: string | null; username?: string | null; isAdmin?: boolean; role?: 'super_admin' | 'admin' | 'user' };
export type Project = DataOf<'ProjectResponse'>;
export type ProjectSummary = DataOf<'ProjectListResponse'>['items'][number];
export type Member = Omit<DataOf<'MemberListResponse'>['items'][number], 'username' | 'isAdmin'> & { username?: string | null; isAdmin?: boolean };
export type Capability = Omit<DataOf<'CapabilitiesResponse'>, 'authentication'> & { authentication?: Partial<NonNullable<DataOf<'CapabilitiesResponse'>['authentication']>> & { mode?: 'password'; passwordEnabled?: boolean; invitationRequired?: boolean; passwordMinLength?: number } };
type CanonicalTask = DataOf<'TaskResponse'>;
type AdditiveTaskMetadata = 'criteria' | 'effortHours' | 'parentTaskId' | 'currentSubmissionId' | 'citations' | 'dependsOnTaskIds' | 'unfinishedDependencyIds';
/** Read-only cached dashboards may still contain task snapshots from before the simplification. */
export type Task = Omit<CanonicalTask, AdditiveTaskMetadata> & Partial<Pick<CanonicalTask, AdditiveTaskMetadata>>;
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

export type ApiEnvelope<T> = { data: T; requestId: string };
export type ApiFailure = {
  error: { code: string; message: string; retryable: boolean; stage?: string; action?: string; requestId?:string; details?: Record<string, unknown> };
  requestId: string;
};
