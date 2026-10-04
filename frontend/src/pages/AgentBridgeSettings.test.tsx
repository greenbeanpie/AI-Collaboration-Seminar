import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentBridgesPage } from './AgentBridgesPage';
import { bridgeApi } from '../api/agent-bridges';
import { preferredBridgeDevice, rememberBridgeDevice } from './useAgentBridge';
const state = vi.hoisted(() => ({ actor: 'u1' }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: state.actor } }) }));
vi.mock('../api/agent-bridges', () => ({ bridgeApi: { devices: vi.fn(), scopes: vi.fn(), updateScopes: vi.fn(), revoke: vi.fn() } }));
const device = { deviceId: 'd1', deviceName: 'Desktop', paired: true, revoked: false, protocolVersion: 1, projects: [{ projectId: 'p1', name: '项目一', workspaceLabel: 'Office' }] };
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter><AgentBridgesPage /></MemoryRouter></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); state.actor = 'u1'; vi.mocked(bridgeApi.devices).mockResolvedValue({ items: [device] }); vi.mocked(bridgeApi.scopes).mockResolvedValue({ items: [{ projectId: 'p1', name: '项目一', authorized: true }, { projectId: 'p2', name: '项目二', authorized: false }] }); vi.mocked(bridgeApi.updateScopes).mockResolvedValue(device); });
afterEach(cleanup);
it('settings exposes automatic connection instructions and persists account scoped default', async () => { mount(); await screen.findByText('Desktop'); expect(screen.getByText(/DSH 启动及网络恢复时会自动连接/)).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '设为此项目默认设备' })); expect(preferredBridgeDevice('p1', 'u1')).toBe('d1'); expect(preferredBridgeDevice('p1', 'u2')).toBe(''); expect(preferredBridgeDevice('p1')).toBe(''); expect(screen.getByRole('button', { name: '此项目默认设备' })).toBeDisabled(); });
it('edits project scope deliberately in settings without authorizing on mount', async () => { mount(); await screen.findByText('Desktop'); expect(bridgeApi.scopes).not.toHaveBeenCalled(); expect(bridgeApi.updateScopes).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '管理项目授权' })); const added = await screen.findByRole('checkbox', { name: '项目二' }); fireEvent.click(added); fireEvent.click(screen.getByRole('button', { name: '保存项目授权' })); await waitFor(() => expect(bridgeApi.updateScopes).toHaveBeenCalledWith('d1', ['p1', 'p2'], 'u1')); expect(screen.queryByRole('tab')).not.toBeInTheDocument(); });
it('never adopts the old project-only preference from another account', () => { localStorage.setItem('agent-bridge-device:pLegacy', 'old'); expect(preferredBridgeDevice('pLegacy', 'u1')).toBe(''); rememberBridgeDevice('p1', 'fresh', 'u1'); expect(preferredBridgeDevice('p1', 'u1')).toBe('fresh'); expect(preferredBridgeDevice('p1', 'u2')).toBe(''); });
