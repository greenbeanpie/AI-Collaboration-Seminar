import { afterEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { aiConfigSchema } from '../src/ai/config';
import { createApp } from '../src/app';
afterEach(() => vi.unstubAllGlobals());

it('Whisper capability needs an enabled configuration and binding; video remains independent', async () => {
  const row = await env.DB.prepare('SELECT id, config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string;config_json:string}>();
  const config = aiConfigSchema.parse(JSON.parse(row!.config_json));
  const app = createApp();
  const read = async (binding: boolean) => {
    const res = await app.fetch(new Request(`${BASE}/api/v1/capabilities`), { ...env, AI: binding ? { run: vi.fn() } : undefined } as typeof env);
    expect(res.status).toBe(200);
    return (await res.json() as {data:{features:{mediaEnabled:boolean;audioTranscriptionEnabled:boolean;videoSummaryEnabled:boolean}}}).data.features;
  };
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=1 WHERE id=?1').bind(row!.id).run();
  expect(await read(true)).toMatchObject({mediaEnabled:true,audioTranscriptionEnabled:true,videoSummaryEnabled:false});
  expect(await read(false)).toMatchObject({mediaEnabled:false,audioTranscriptionEnabled:false,videoSummaryEnabled:false});
  config.audioProcessingStrategy = 'gemini-only';
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(row!.id,JSON.stringify(config)).run();
  expect(await read(true)).toMatchObject({mediaEnabled:false,audioTranscriptionEnabled:false,videoSummaryEnabled:false});
  config.mediaUnderstanding = {...config.textEconomy,apiKeyEncrypted:'fixture-encrypted-key'};
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(row!.id,JSON.stringify(config)).run();
  expect(await read(true)).toMatchObject({mediaEnabled:true,audioTranscriptionEnabled:false,videoSummaryEnabled:true});
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=0 WHERE id=?1').bind(row!.id).run();
  expect(await read(true)).toMatchObject({mediaEnabled:false,audioTranscriptionEnabled:false,videoSummaryEnabled:false});
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(row!.id,row!.config_json).run();
});
