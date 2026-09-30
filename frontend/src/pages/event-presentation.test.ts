import { describe, expect, it } from 'vitest';
import { presentEvent } from './event-presentation';

describe('event presentation', () => {
  it('shows the actual decision and material version', () => {
    expect(presentEvent({ type: 'decision.recorded', actorType: 'user', payload: { title: '确认作品结构' } }).detail).toBe('确认作品结构');
    expect(presentEvent({ type: 'material.saved', actorType: 'user', payload: { revision: 5 } }).detail).toContain('r5');
  });
  it('translates task states without inventing unknown values', () => {
    expect(presentEvent({ type: 'task.status_changed', actorType: 'user', payload: { from: 'todo', to: 'doing' } }).detail).toBe('待开始 → 进行中');
    expect(presentEvent({ type: 'task.status_changed', actorType: 'user', payload: { from: 'future', to: 'doing' } }).detail).toContain('请在任务页查看');
  });
  it('keeps AI generation distinct from human adoption', () => {
    expect(presentEvent({ type: 'ai.run_succeeded', actorType: 'ai', payload: {} }).detail).toContain('人工复核');
    expect(presentEvent({ type: 'material.adopted', actorType: 'user', payload: {} }).detail).toContain('成员确认');
  });
  it('does not expose arbitrary internal payloads', () => {
    expect(JSON.stringify(presentEvent({ type: 'future.internal', actorType: 'system', payload: { internalId: 'private-detail' } }))).not.toContain('private-detail');
  });
});
