export type RecordingKind = 'audio' | 'video' | 'photo';
export interface RecordingInterruption { startMs: number; endMs: number; reason: string }
export interface RecordingSession {
 sessionId:string;clientSessionId:string;materialId:string;title:string;kind:RecordingKind;
 status:'uploading'|'complete';processingStatus:'pending'|'running'|'ready'|'partial'|'unconfigured'|'failed';
 createdAt:string;updatedAt:string;segmentCount:number;summaryRevision:number;
}
export interface RecordingSegment {
 sequence:number;fileId:string;sourceId:string;sourceVersionId:string;startMs:number;endMs:number;sha256:string;
 status:string;error:string|null;interruptions:RecordingInterruption[];
}
export interface RecordingSessionDetail extends RecordingSession {
 segments:RecordingSegment[];nextCursor:string|null;summaryMarkdown:string;interruptions:RecordingInterruption[];
}
export interface CreateRecordingSession { clientSessionId:string;title:string;kind:RecordingKind;purpose?:'background'|'reference'|'output';contributorIds?:string[] }
export interface RegisterRecordingSegment { fileId:string;startMs:number;endMs:number;sha256:string;interruptions?:RecordingInterruption[] }
export interface CompleteRecordingSession { segmentCount:number;interruptions?:RecordingInterruption[] }
export const RECORDING_SEGMENT_MS = 300_000;
export const RECORDING_SEGMENT_BYTES = 32 * 1024 * 1024;
