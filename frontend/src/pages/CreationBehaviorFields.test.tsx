import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreationBehaviorFields } from './CreationBehaviorFields';
import { creationBehavior, emptyWizardPayload, type WizardPayload } from './project-wizard';
describe('creation AI behavior', () => {
  it('defaults new drafts to enabled automatic behavior and preserves choices through toggles', () => {
    function Form() { const [payload,setPayload] = useState(emptyWizardPayload); return <><input aria-label="AI 开关" type="checkbox" checked={payload.aiCollaborationEnabled} onChange={event => setPayload({...payload, aiCollaborationEnabled:event.target.checked})}/><CreationBehaviorFields payload={payload} onChange={(key,value) => setPayload({...payload,[key]:value})}/></>; }
    render(<Form/>);
    expect(screen.getByLabelText('AI 开关')).toBeChecked();
    for (const label of ['任务规划','任务分工','提交验收','项目推进']) expect(screen.getByLabelText(label)).toHaveValue('automatic');
    fireEvent.change(screen.getByLabelText('任务规划'),{target:{value:'manual'}});
    fireEvent.click(screen.getByLabelText('AI 开关'));
    expect(screen.getByLabelText('任务规划')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('AI 开关'));
    expect(screen.getByLabelText('任务规划')).toHaveValue('manual');
    expect(screen.getByLabelText('任务分工')).toHaveValue('automatic');
  });
  it('uses legacy behavior defaults only for existing fields that are missing', () => {
    const old = { ...emptyWizardPayload, planningMode:undefined, assignmentMode:undefined, evaluationMode:undefined, progressionMode:undefined } as WizardPayload;
    expect(creationBehavior(old,'planningMode')).toBe('manual');
    expect(creationBehavior(old,'progressionMode')).toBe('manual');
    expect(creationBehavior(old,'assignmentMode')).toBe('automatic');
    expect(creationBehavior({...old,aiCollaborationEnabled:false},'evaluationMode')).toBe('manual');
  });
});
