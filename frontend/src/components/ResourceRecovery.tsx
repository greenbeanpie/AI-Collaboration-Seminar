import { useNavigate } from 'react-router-dom';

export function ResourceRecovery() {
  const navigate = useNavigate();
  return <section className="section-card" role="alert">
    <h1>页面资源暂时不可用</h1>
    <p>可能已有新版本，或当前网络不可用。页面不会自动重新加载。请先保存未提交的编辑；取消更新会保留当前页面。</p>
    <div className="button-row">
      <button className="button" onClick={() => navigate(-1)}>返回上一页</button>
      <button className="button button-primary" onClick={() => window.dispatchEvent(new Event('app-update-request'))}>检查并确认更新</button>
    </div>
  </section>;
}
