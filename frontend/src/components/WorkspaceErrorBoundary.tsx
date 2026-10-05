import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation, useRouteError, useRevalidator } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { errorMessage } from '../api/error-info';

function ErrorPage({ error, retry }: {error:unknown; retry:()=>void}) {
  return <main className="center-screen"><section className="welcome-card" role="alert">
    <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{errorMessage(error)}</p>
    <div className="welcome-actions"><button className="button button-primary" onClick={retry}>重试读取</button><button className="button button-quiet" onClick={()=>window.location.reload()}>刷新页面</button><a className="button button-quiet" href="/app">返回我的项目</a></div>
  </section></main>;
}

class RenderBoundary extends Component<{children:ReactNode;onRetry:()=>void}, {error:unknown;componentStack:string;capturedAt:string}> {
  state = {error:null as unknown,componentStack:'',capturedAt:''};
  static getDerivedStateFromError(error:unknown) { return {error,capturedAt:new Date().toISOString()}; }
  componentDidCatch(_error:Error,info:ErrorInfo) { this.setState({componentStack:info.componentStack??''}); }
  render() {
    if(this.state.error) return <ErrorPage error={this.state.error} retry={()=>{this.props.onRetry();this.setState({error:null,componentStack:'',capturedAt:''});}}/>;
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
  return <ErrorPage error={error} retry={()=>{void client.invalidateQueries();void revalidator.revalidate();}}/>;
}
