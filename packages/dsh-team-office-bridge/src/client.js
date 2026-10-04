import React, {useState,useEffect} from 'react';
export const inject=['slots'];
export function apply(ctx) {
  function BridgeCard(props) {
    const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const read=async()=>{const r=await fetch('/api/team-office-bridge/config',{credentials:'same-origin'});const data=await r.json();if(!r.ok)throw new Error(data.error);setState(data);};
    useEffect(()=>{let alive=true;const update=()=>{if(alive)void read().catch(e=>setError(e.message));};update();const id=setInterval(update,5000);return()=>{alive=false;clearInterval(id);};},[]);
    const act=async(action,fields={})=>{const popup=action==='connect'?window.open('about:blank','_blank'):null;setBusy(true);setError('');try{const r=await fetch('/api/team-office-bridge/config',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...fields})});const data=await r.json();if(!r.ok)throw new Error(data.error);setState(data);if(popup){if(data.approvalUrl){popup.opener=null;popup.location.href=data.approvalUrl;}else popup.close();}}catch(e){popup?.close();setError(e.message);}finally{setBusy(false);}};
    if(props.view==='summary')return '从项目办公室接收任务，在当前 DSH 执行并回传成果草稿。';
    const button=(label,action,fields)=>React.createElement('button',{type:'button',disabled:busy||state?.compatible===false,onClick:()=>act(action,fields),style:{padding:'8px 12px',margin:'4px'}},label);
    return React.createElement('section',{style:{padding:16,display:'grid',gap:10,maxWidth:640}},
      React.createElement('h3',null,'补位 · 本地 DSH 桥接器'),
      React.createElement('p',null,'首次连接网站并为项目选择目录。日常在网站点击“交给本地 Agent”。执行时保持 DSH 运行，审批在 DSH 中处理。'),
      React.createElement('p',{role:'status'},state?.paired?'已连接':state?.configured?'等待网站授权':'尚未连接'),
      state?.compatibilityMessage&&React.createElement('p',{role:'alert'},state.compatibilityMessage),
      error&&React.createElement('p',{role:'alert'},error),state?.error&&React.createElement('p',{role:'alert'},state.error),
      !state?.paired&&button('连接网站','connect'),
      !state?.paired&&state?.approvalUrl&&React.createElement('a',{href:state.approvalUrl,target:'_blank',rel:'noopener noreferrer'},'打开网站确认连接'),
      state?.configured&&button('刷新连接','refresh'),state?.configured&&button('断开连接','disconnect'),
      ...(state?.projects||[]).map(p=>React.createElement('div',{key:p.projectId},React.createElement('strong',null,p.name),React.createElement('span',null,p.bound?` · ${p.localLabel}`:' · 尚未选择目录'),button(p.bound?'更换目录':'选择本地目录','bind',{projectId:p.projectId}))),
      ...(state?.runs||[]).slice(-5).map(r=>React.createElement('p',{key:r.handoffId},`${r.handoffId}: ${r.state}`)),
      React.createElement('small',null,'仅回传本次任务 outputs 内明确登记的成果；网站采纳与提交验收由用户完成。'));
  }
  ctx.slots.inject('plugins.item',()=>ctx.slots.register({name:'plugins.item',id:'team-office-bridge',order:20,label:()=> '补位桥接器',inject:()=>({})},BridgeCard));
}
