const actions = {
  correct_input:'修正输入后再提交',
  sign_in:'重新登录或重新获取有效验证信息',
  check_access:'请项目负责人或管理员核对权限',
  refresh_state:'先刷新并核对操作是否已完成，再决定是否提交',
  wait_then_retry:'等待限制解除后再手动操作，请勿连续重试',
  check_file:'核对原文件格式和大小后再操作',
  check_source:'核对来源和处理状态，原文件可保留供检查',
  configure_ai:'请管理员核对已保存的模型配置及诊断日志',
  review_model_result:'核对模型处理状态，确认后再手动重试',
  check_delivery:'核对发送状态后再决定是否重新发送',
  contact_admin:'向管理员提供请求编号，并先核对操作结果',
  check_connection:'检查网络和服务连接后再操作',
} as const;
const stages = ['validation','authentication','authorization','state','limits','upload','source_parse','model_configuration','model_response','delivery','internal','request','network'];
const knownCodes = new Set(['VALIDATION_FAILED','UNAUTHENTICATED','AUTH_CHALLENGE_INVALID','AUTH_CHALLENGE_EXPIRED','AUTH_ATTEMPTS_EXCEEDED','RATE_LIMITED','PERMISSION_DENIED','NOT_FOUND','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','INVALID_STATE','FILE_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','SOURCE_PARSE_FAILED','PAGE_INVALID','QUOTA_EXCEEDED','AI_OUTPUT_INVALID','AI_UNAVAILABLE','EMAIL_UNAVAILABLE','INTERNAL','NETWORK_ERROR','INVALID_RESPONSE','INVALID_PAGINATION','PAGINATION_LIMIT']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function publicErrorMessage(code:string, message:string): string {
  if(code==='INVALID_STATE'&&(!message.trim()||message.includes('或')))return '当前操作状态已变化，请刷新核对。';
  const fixed: Record<string,string> = {
    INTERNAL:'服务器内部错误，请核对操作结果并联系管理员',
    AI_UNAVAILABLE:'模型服务暂不可用，请核对已保存的模型配置',
    EMAIL_UNAVAILABLE:'邮件服务暂不可用，请核对发送状态',
    SOURCE_PARSE_FAILED:'来源处理未完成，请核对来源文件及处理状态',
  };
  return Object.hasOwn(fixed,code) ? fixed[code] : message || '请求失败';
}

export function errorInfo(error: {code:string;stage?:unknown;action?:unknown}, requestId:string): string {
  const parts:string[]=[];
  if(typeof error.action==='string' && Object.hasOwn(actions,error.action))parts.push(`建议：${actions[error.action as keyof typeof actions]}`);
  if(knownCodes.has(error.code)||/^HTTP_[1-5][0-9]{2}$/.test(error.code))parts.push(`错误代码：${error.code}`);
  if(typeof error.stage==='string'&&stages.includes(error.stage))parts.push(`阶段：${error.stage}`);
  if(uuid.test(requestId))parts.push(`请求编号：${requestId.toLowerCase()}`);
  return parts.join('；');
}
