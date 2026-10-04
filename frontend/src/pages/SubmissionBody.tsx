import { useState } from 'react';
export function SubmissionBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="submission-body" onToggle={event => setExpanded(event.currentTarget.open)}><summary>{expanded ? '收起提交内容' : '展开提交内容'}</summary><p className="collab-preserve">{body}</p></details>;
}
