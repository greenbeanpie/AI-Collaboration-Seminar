import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { projectRequest } from '../api/simplification';
import { ErrorNotice, Field } from '../components/ui';
export function ProjectAiFeedback({projectId}:{projectId:string}) {
 const [feedback,setFeedback]=useState('');const [redo,setRedo]=useState(false);
 const save=useMutation({mutationFn:()=>projectRequest(projectId,'/collaboration/feedback',{method:'POST',body:{feedback:feedback.trim(),targetType:'project',requestAiRedo:redo}}),onSuccess:()=>setFeedback('')});
 return <details><summary>负责人反馈与重新判断</summary><form className="stack" onSubmit={event=>{event.preventDefault();save.mutate();}}><p className="form-note">反馈将作为后续 AI 判断的依据。人工反馈不受 AI 自动审核设置限制；AI 未启用时仍可保存。</p><Field label="项目修正反馈"><textarea className="input" required maxLength={4000} value={feedback} onChange={event=>setFeedback(event.target.value)}/></Field><label className="checkbox-row"><input type="checkbox" checked={redo} onChange={event=>setRedo(event.target.checked)}/>要求 AI 根据最新情况重新判断</label>{save.error&&<ErrorNotice error={save.error}/>}<button className="button" disabled={!feedback.trim()||save.isPending}>保存项目反馈</button>{save.isSuccess&&<p role="status">反馈已保存</p>}</form></details>;
}
