import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.__UPDATES_TEST__ = true;
const { UpdateController, NotificationHistory } = await import('../public/app-updates.js');

function setup({ controlled = true, online = true, enabled = true } = {}) {
  vi.useFakeTimers();
  const sw = new EventTarget(); sw.controller = controlled ? { state: 'activated' } : null;
  const registration = new EventTarget();
  Object.assign(registration, { active: controlled ? { state: 'activated' } : null, waiting: null, installing: null, update: vi.fn(async () => {}) });
  sw.register = vi.fn(async () => registration);
  const env = { sw, enabled, online: () => online, confirm: vi.fn(() => true), reload: vi.fn(), setTimeout, clearTimeout };
  const states = [];
  const controller = new UpdateController(env, state => states.push(state));
  function worker() {
    const worker = new EventTarget(); worker.state = 'installing'; worker.postMessage = vi.fn();
    worker.advance = state => { worker.state = state; worker.dispatchEvent(new Event('statechange')); };
    return worker;
  }
  return { controller, env, registration, states, worker, sw };
}

afterEach(() => { vi.useRealTimers(); });
describe('application update lifecycle', () => {
  it('offers honest confirmed recovery for missing resources without claiming a downloaded update', async () => {
    const t = setup(); await t.controller.start(); t.controller.resourcesMissing = true; await t.controller.check();
    expect(t.controller.state).toBe('refresh'); expect(t.states).not.toContain('ready');
    t.env.confirm.mockReturnValue(false); t.controller.apply(); expect(t.env.reload).not.toHaveBeenCalled();
    t.env.confirm.mockReturnValue(true); t.controller.apply(); t.controller.apply(); expect(t.env.reload).toHaveBeenCalledTimes(1);
    const unsupported = setup({ enabled: false }); unsupported.controller.resourcesMissing = true; await unsupported.controller.check();
    expect(unsupported.controller.state).toBe('refresh'); expect(unsupported.env.reload).not.toHaveBeenCalled();
  });
  it('finds an already waiting update without initiating activation', async () => {
    const t = setup(); t.registration.waiting = t.worker(); await t.controller.start();
    expect(t.controller.state).toBe('ready'); expect(t.registration.waiting.postMessage).not.toHaveBeenCalled();
    expect(t.sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });
  it('does not report first installation as an update', async () => {
    const t = setup({ controlled: false }); const worker = t.worker(); t.registration.installing = worker;
    await t.controller.start(); worker.advance('installed');
    expect(t.states).not.toContain('ready'); expect(t.states).not.toContain('downloading');
    expect(t.env.reload).not.toHaveBeenCalled();
  });
  it('never reloads or announces an update when the first installation claims the page', async () => {
    const t = setup({ controlled: false }); const worker = t.worker(); t.registration.installing = worker;
    await t.controller.start(); worker.advance('installed'); worker.advance('activating');
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange')); worker.advance('activated');
    expect(t.env.reload).not.toHaveBeenCalled(); expect(t.states).not.toContain('ready');
  });
  it('shows downloading then ready and keeps cancellation inert', async () => {
    const t = setup(); await t.controller.start(); const worker = t.worker(); t.registration.installing = worker;
    t.registration.dispatchEvent(new Event('updatefound')); expect(t.controller.state).toBe('downloading');
    t.registration.waiting = worker; t.registration.installing = null; worker.advance('installed');
    t.env.confirm.mockReturnValue(false); t.controller.apply();
    expect(t.controller.state).toBe('ready'); expect(worker.postMessage).not.toHaveBeenCalled(); expect(t.env.reload).not.toHaveBeenCalled();
  });
  it('requires confirmation, sends one activation and reloads only once', async () => {
    const t = setup(); const worker = t.worker(); t.registration.waiting = worker; await t.controller.start();
    t.controller.apply(); t.controller.apply();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
    expect(t.env.confirm).toHaveBeenCalledTimes(1); expect(t.env.reload).not.toHaveBeenCalled();
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange')); worker.advance('activated'); t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).toHaveBeenCalledTimes(1);
  });
  it('does not reload an activated update while the old worker still controls the page', async () => {
    const t = setup(); const worker = t.worker(); t.registration.waiting = worker; await t.controller.start();
    t.controller.apply(); worker.advance('activated');
    expect(t.env.reload).not.toHaveBeenCalled();
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).toHaveBeenCalledTimes(1);
  });
  it('waits for activation to finish when the new worker claims the page first', async () => {
    const t = setup(); const worker = t.worker(); t.registration.waiting = worker; await t.controller.start();
    t.controller.apply(); worker.advance('activating');
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).not.toHaveBeenCalled();
    worker.advance('activated'); t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).toHaveBeenCalledTimes(1);
  });
  it('ignores an unrelated controller and a late takeover after an activation timeout', async () => {
    const t = setup(); const worker = t.worker(); t.registration.waiting = worker; await t.controller.start();
    t.controller.apply(); worker.advance('activated');
    t.sw.controller = { state: 'activated' }; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20000); expect(t.controller.state).toBe('error');
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).not.toHaveBeenCalled();
  });
  it('does not reload another tab until that tab confirms', async () => {
    const t = setup(); await t.controller.start(); const other = t.worker(); other.advance('activated'); t.sw.controller = other; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).not.toHaveBeenCalled(); expect(t.controller.state).toBe('ready');
    t.env.confirm.mockReturnValue(false); t.controller.apply(); expect(t.env.reload).not.toHaveBeenCalled();
    t.env.confirm.mockReturnValue(true); t.controller.apply(); expect(t.env.reload).toHaveBeenCalledTimes(1);
  });
  it('waits for an update from another tab to finish activating after this tab confirms', async () => {
    const t = setup(); await t.controller.start(); const worker = t.worker(); worker.advance('activating');
    t.sw.controller = worker; t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.env.reload).not.toHaveBeenCalled(); t.controller.apply();
    expect(t.env.reload).not.toHaveBeenCalled(); worker.advance('activated');
    expect(t.env.reload).toHaveBeenCalledTimes(1); expect(worker.postMessage).not.toHaveBeenCalled();
  });
  it('deduplicates checks and distinguishes latest, failure and retry', async () => {
    const t = setup(); await t.controller.start();
    await Promise.all([t.controller.check(), t.controller.check()]); expect(t.registration.update).toHaveBeenCalledTimes(1); expect(t.controller.state).toBe('latest');
    t.registration.update.mockRejectedValueOnce(new Error('network')); await t.controller.check(); expect(t.controller.state).toBe('error');
    await t.controller.check(); expect(t.controller.state).toBe('latest');
  });
  it('handles offline, unsupported and failed installation without reloading', async () => {
    const offline = setup({ online: false }); await offline.controller.check(); expect(offline.controller.state).toBe('offline');
    const unsupported = setup({ enabled: false }); await unsupported.controller.check(); expect(unsupported.controller.state).toBe('unsupported');
    const t = setup(); const worker = t.worker(); t.registration.installing = worker; await t.controller.start(); worker.advance('redundant'); expect(t.controller.state).toBe('error');
    expect(t.env.reload).not.toHaveBeenCalled();
  });
  it('times out stalled downloads and activation without forced reload', async () => {
    const t = setup(); const worker = t.worker(); t.registration.installing = worker; await t.controller.start();
    vi.advanceTimersByTime(120000); expect(t.controller.state).toBe('error');
    t.registration.waiting = worker; t.registration.installing = null; worker.advance('installed'); t.controller.apply();
    vi.advanceTimersByTime(20000); expect(t.controller.state).toBe('error'); expect(t.env.reload).not.toHaveBeenCalled();
  });
  it('does not execute a stale ready action after waiting worker disappears', async () => {
    const t = setup(); t.registration.waiting = t.worker(); await t.controller.start(); t.registration.waiting = null;
    t.controller.apply(); expect(t.controller.state).toBe('error'); expect(t.env.reload).not.toHaveBeenCalled();
  });
});

describe('session notification history', () => {
  it('updates progress in place and caps history', () => {
    const h = new NotificationHistory(); h.add('update', 'download'); h.add('update', 'ready'); expect(h.items).toHaveLength(1);
    for (let i = 0; i < 40; i++) h.add(String(i), 'notice'); expect(h.items).toHaveLength(30); expect(h.items[0].text).toBe('notice');
  });
  it('clears all actions and content between accounts, guests and projects', () => {
    const h = new NotificationHistory(); h.reset('account:a:project:1'); h.add('update', 'ready', 'info', 'update');
    h.reset('account:a:project:1'); expect(h.items).toHaveLength(1);
    for (const scope of ['account:b:project:1', 'guest', 'account:b:project:2']) { h.reset(scope); expect(h.items).toHaveLength(0); h.add('notice', 'safe summary'); }
  });
});
