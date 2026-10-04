import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bridgeApi } from '../api/agent-bridges';
import { ErrorNotice, Spinner } from '../components/ui';
import { bridgeDevicesKey, rememberBridgeDevice, useBridgeDevices } from './useAgentBridge';
import { useSession } from '../auth';

// DSH downloads are machine requests; use the published endpoint without the custom-domain browser challenge.
const bridgePackageUrl = 'https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.0.tgz';

export function AgentBridgesPage() {
  const client = useQueryClient();
  const session = useSession();
  const currentActor = useRef(session.data?.id);
  useEffect(() => { currentActor.current = session.data?.id; }, [session.data?.id]);
  const [params] = useSearchParams();
  const pairingId = params.get('pairing') ?? '';
  const [projects, setProjects] = useState<string[]>([]);
  const devices = useBridgeDevices();
  const pairing = useQuery({ queryKey: ['agent-bridge-pairing', pairingId, session.data?.id], enabled: Boolean(pairingId && session.data?.id), retry: false, networkMode: 'always', queryFn: ({ signal }) => bridgeApi.pairing(pairingId, signal) });
  const approve = useMutation({ retry: false, networkMode: 'always', mutationFn: async () => { const actorId = session.data?.id ?? ''; await bridgeApi.approve(pairingId, projects, actorId); return actorId; }, onSuccess: async actorId => { if (currentActor.current !== actorId) return; await pairing.refetch(); await client.invalidateQueries({ queryKey: bridgeDevicesKey }); } });
  const revoke = useMutation({ retry: false, networkMode: 'always', mutationFn: async (deviceId: string) => { const actorId = session.data?.id; await bridgeApi.revoke(deviceId); return actorId; }, onSuccess: async actorId => { if (currentActor.current === actorId) await client.invalidateQueries({ queryKey: bridgeDevicesKey }); } });
  const expired = pairing.data && Date.parse(pairing.data.expiresAt) <= Date.now();
  return <div className="page-stack"><h1>本地 Agent</h1><p>在 DSH 中安装补位桥接器，连接账号，并为项目选择一次工作目录。此后在任务卡片点击“交给本地 Agent”，成果自动回传为草稿。</p><ol><li>打开 DSH 的插件管理器，选择安装插件，将以下链接粘贴为安装来源：<p><a style={{ overflowWrap: 'anywhere' }} href={bridgePackageUrl}>{bridgePackageUrl}</a></p></li><li>在插件中点击“连接网站”，在打开的页面确认设备及项目。</li><li>回到 DSH，选择项目工作目录，保持 DSH 打开。</li></ol>
    {pairingId && <section className="welcome-card stack" aria-label="设备连接授权"><h2>连接 DSH</h2>{pairing.isPending && <Spinner label="读取连接请求" />}{pairing.error && <ErrorNotice error={pairing.error} onRetry={() => void pairing.refetch()} />}{pairing.data && <><p>设备：<strong>{pairing.data.deviceName}</strong></p>{pairing.data.status === 'approved' || (approve.isSuccess && approve.data === session.data?.id) ? <p role="status">连接已授权，请回到 DSH 选择项目工作目录。</p> : expired || pairing.data.status === 'expired' ? <p role="alert">连接请求已过期，请在 DSH 中重新连接。</p> : <><p>仅授权所选项目的任务输入和成果回传。你可以随时撤销连接。</p>{pairing.data.projects?.map(project => <label key={project.projectId}><input type="checkbox" checked={projects.includes(project.projectId)} onChange={event => setProjects(previous => event.target.checked ? [...previous, project.projectId] : previous.filter(id => id !== project.projectId))} /> {project.name}</label>)}{pairing.data.projects?.length === 0 && <p>当前账号没有可授权的项目。</p>}<button className="button button-primary" disabled={projects.length === 0 || approve.isPending} onClick={() => approve.mutate()}>确认连接并授权项目</button></>}</>}{approve.error && <ErrorNotice error={approve.error} />}</section>}
    <section className="stack" aria-label="已连接设备"><h2>已连接设备</h2>{devices.isPending && <Spinner label="读取设备" />}{devices.error && <ErrorNotice error={devices.error} onRetry={() => void devices.refetch()} />}{devices.data?.items.length === 0 && <p>尚未连接设备。请从 DSH 插件开始连接。</p>}{devices.data?.items.map(device => <article key={device.deviceId} className="welcome-card stack"><h3>{device.deviceName}</h3><p>{device.revoked ? '连接已撤销' : device.lastSeenAt && Date.now() - Date.parse(device.lastSeenAt) < 90_000 ? 'DSH 在线' : '等待 DSH 上线'}</p>{device.projects.map(project => <p key={project.projectId}>{project.name}：{project.workspaceLabel ? `已绑定工作目录（${project.workspaceLabel}）` : '请在 DSH 中选择工作目录'} {!device.revoked && project.workspaceLabel && <button className="button button-quiet button-small" onClick={() => { rememberBridgeDevice(project.projectId, device.deviceId); void devices.refetch(); }}>设为此项目默认设备</button>}</p>)}{!device.revoked && <button className="button" disabled={revoke.isPending} onClick={() => revoke.mutate(device.deviceId)}>撤销此设备连接</button>}</article>)}{revoke.error && <ErrorNotice error={revoke.error} />}</section>
  </div>;
}
