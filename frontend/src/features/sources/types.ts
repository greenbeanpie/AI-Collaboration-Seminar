import type { DataOf } from '../../api/types';
export type SourceItem = DataOf<'SourceListResponse'>['items'][number];
export type SourceVersion = DataOf<'SourceVersionResponse'>;
export type Job = DataOf<'JobResponse'>;
export type CapabilityData = DataOf<'CapabilitiesResponse'>;
export type IntakeKind = 'paste' | 'web' | 'file';
export type PendingUpload = { fileId: string; file: File };
export type PageImagesBody = { sourceVersionId: string; images: Array<{ pageNumber: number; fileId: string }> };
export type PendingPageImagesSubmission = { body: PageImagesBody; idempotencyKey: string };

