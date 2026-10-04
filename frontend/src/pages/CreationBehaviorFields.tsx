import { Field } from '../components/ui';
import { creationBehaviors, creationBehavior, type CreationMode, type WizardPayload } from './project-wizard';
export function CreationBehaviorFields({ payload, disabled = false, onChange }: { payload: WizardPayload; disabled?: boolean; onChange: (key: typeof creationBehaviors[number][0], value: CreationMode) => void }) {
  return <fieldset disabled={disabled || !payload.aiCollaborationEnabled}><legend>AI 行为配置（可选）</legend>{creationBehaviors.map(([key, label]) => <Field key={key} label={label}><select aria-label={label} className="input" value={creationBehavior(payload, key)} onChange={event => onChange(key, event.target.value as CreationMode)}><option value="automatic">自动执行</option><option value="manual">事先由负责人确认</option></select></Field>)}<small>关闭 AI 时保留配置。生成预览需主动点击，可能产生模型用量。</small></fieldset>;
}
