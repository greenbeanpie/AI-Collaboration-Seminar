export const ERROR_STAGES = ['validation','authentication','authorization','state','limits','upload','source_parse','model_configuration','model_response','delivery','internal','request','network'] as const;
export const ERROR_ACTIONS = ['correct_input','sign_in','check_access','refresh_state','wait_then_retry','check_file','check_source','configure_ai','review_model_result','check_delivery','contact_admin','check_connection'] as const;
export type ErrorStage = typeof ERROR_STAGES[number];
export type ErrorAction = typeof ERROR_ACTIONS[number];

/** Fixed categories only; never inspect a provider body, stack, URL or secret. */
export function errorGuidance(code: string): {stage: ErrorStage; action: ErrorAction} {
  switch(code) {
    case 'VALIDATION_FAILED': case 'PAGE_INVALID': return {stage:'validation',action:'correct_input'};
    case 'UNAUTHENTICATED': case 'AUTH_CHALLENGE_INVALID': case 'AUTH_CHALLENGE_EXPIRED': case 'AUTH_ATTEMPTS_EXCEEDED': return {stage:'authentication',action:'sign_in'};
    case 'PERMISSION_DENIED': return {stage:'authorization',action:'check_access'};
    case 'VERSION_CONFLICT': case 'IDEMPOTENCY_CONFLICT': case 'INVALID_STATE': return {stage:'state',action:'refresh_state'};
    case 'RATE_LIMITED': case 'QUOTA_EXCEEDED': return {stage:'limits',action:'wait_then_retry'};
    case 'FILE_TOO_LARGE': case 'UNSUPPORTED_MEDIA_TYPE': return {stage:'upload',action:'check_file'};
    case 'SOURCE_PARSE_FAILED': return {stage:'source_parse',action:'check_source'};
    case 'AI_UNAVAILABLE': return {stage:'model_configuration',action:'configure_ai'};
    case 'AI_OUTPUT_INVALID': return {stage:'model_response',action:'review_model_result'};
    case 'EMAIL_UNAVAILABLE': return {stage:'delivery',action:'check_delivery'};
    case 'INTERNAL': return {stage:'internal',action:'contact_admin'};
    case 'NETWORK_ERROR': return {stage:'network',action:'check_connection'};
    default: return {stage:'request',action:'refresh_state'};
  }
}
