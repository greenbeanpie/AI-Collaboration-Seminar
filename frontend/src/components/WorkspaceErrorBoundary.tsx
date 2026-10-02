import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useLocation, useRouteError, useRevalidator } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { errorDiagnostics } from './error-diagnostics';

function ErrorPage({ diagnostics, retry }: {diagnostics:string; retry:()=>void}) {
  return <main className="center-screen"><section className="welcome-card" role="alert">
    <h1>工作区暂时遇到问题</h1><p>请重新读取页面。若刚才进行了保存或提交，请先核对结果，避免重复操作。</p>
    <div className="welcome-actions"><button className="button button-primary" onClick={retry}>重试读取</button><button className="button button-quiet" onClick={()=>window.location.reload()}>刷新页面</button><a className="button button-quiet" href="/app">返回我的项目</a></div>
    <ErrorDetails diagnostics={diagnostics}/>
  </section></main>;
}

export function ErrorDetails({diagnostics}:{diagnostics:string}) {
  const [copyStatus, setCopyStatus] = useState('');
  const [open, setOpen] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(diagnostics); setCopyStatus('错误详情已复制，可发送给管理员。'); }
    catch { setCopyStatus('复制失败，请在下方选中并手动复制错误详情。'); }
  }
  return <details open={open}><summary onClick={event=>{event.preventDefault();setOpen(value=>!value);}}>查看错误详情</summary>{open && <><p>可以复制以下诊断信息以报告问题。</p><button className="button button-quiet" onClick={()=>void copy()}>复制完整错误详情</button><p role="status">{copyStatus}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'45vh',overflow:'auto',userSelect:'text'}}>{diagnostics}</pre></>}</details>;
}

class RenderBoundary extends Component<{children:ReactNode;onRetry:()=>void}, {error:unknown;componentStack:string;capturedAt:string}> {
  state = {error:null as unknown,componentStack:'',capturedAt:''};
  static getDerivedStateFromError(error:unknown) { return {error,capturedAt:new Date().toISOString()}; }
  componentDidCatch(_error:Error,info:ErrorInfo) { this.setState({componentStack:info.componentStack??''}); }
  render() {
    if(this.state.error) return <ErrorPage diagnostics={errorDiagnostics(this.state.error,this.state.componentStack,this.state.capturedAt)} retry={()=>{this.props.onRetry();this.setState({error:null,componentStack:'',capturedAt:''});}}/>;
    return this.props.children;
  }
}

export function WorkspaceErrorBoundary({children}:{children:ReactNode}) {
  const location=useLocation();
  const client=useQueryClient();
  return <RenderBoundary key={location.pathname} onRetry={()=>{void client.invalidateQueries();}}>{children}</RenderBoundary>;
}
export function RouteErrorPage() {
  const error=useRouteError(), revalidator=useRevalidator(), client=useQueryClient();
  return <ErrorPage diagnostics={errorDiagnostics(error)} retry={()=>{void client.invalidateQueries();void revalidator.revalidate();}}/>;
}
