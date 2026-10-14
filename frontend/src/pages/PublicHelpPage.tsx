import { Link } from 'react-router-dom';

export function PublicHelpPage() {
  return <main className="content-wrap narrow-page page-stack"><section className="card form-card"><h1>注册与账户帮助</h1><p>注册需要系统管理员提供的16位一次性注册邀请码。项目邀请用于加入团队；请先注册或登录，再回到邀请预览确认加入。</p><h2>忘记密码</h2><p>优先使用已绑定且验证的恢复邮箱。注册时填写但未验证的邮箱无法用于恢复；登录后可在账户安全设置验证邮箱。</p><Link className="button button-primary" to="/password-forgot">通过邮件恢复密码</Link><h2>管理员人工恢复（后备）</h2><p>无法使用已验证邮箱时，请联系 <a href="mailto:2945531970@qq.com">2945531970@qq.com</a>，提供登录用户名及可核实的账户归属说明。不要发送密码、API密钥或完整项目资料。</p><p>超级管理员人工核实后，可提供30分钟有效的一次性恢复代码。</p><Link className="button button-quiet" to="/password-reset">使用管理员提供的恢复代码</Link><Link className="button button-quiet" to="/login">返回登录</Link><a className="button button-quiet" href="/guest/index.html">查看游客演示</a></section></main>;
}
