import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

assert(process.argv.includes('--production'), 'Pass --production explicitly');
const option = name => process.argv[process.argv.indexOf(name) + 1];
assert(process.argv.includes('--credentials') && process.argv.includes('--audio'), 'Provide private credential file and synthetic audio fixture');
const origin = process.env.RELEASE_URL || 'https://team.greenbp.dpdns.org';
assert(['https://team.greenbp.dpdns.org', 'https://greenbp-team-office.hddhp.workers.dev'].includes(origin));
const output = resolve(process.argv.includes('--output') ? option('--output') : 'output/whisper-release');
mkdirSync(output, { recursive: true });
const report = { origin, checks: [], limitations: [], draftId: null, fileId: null, jobId: null, finalPhase: null, result: 'RUNNING' };
let cookie = '';
async function request(path, method = 'GET', body, raw = false) {
  const response = await fetch(origin + '/api/v1' + path, {
    method, headers: { ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': raw ? 'audio/wav' : 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const envelope = await response.json();
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (!response.ok) {
    const error = new Error(`${method} ${path}: HTTP ${response.status}; ${envelope.error?.code ?? 'unknown'}`);
    error.status = response.status;
    throw error;
  }
  return envelope.data;
}
try {
  const saved = JSON.parse(readFileSync(resolve(option('--credentials')), 'utf8'));
  const candidates = [...(saved.acceptanceAccounts ?? [])].reverse();
  if (saved.accounts?.production) candidates.push(saved.accounts.production);
  let authenticated = false;
  for (const account of candidates) {
    if (!account?.username || !account?.password) continue;
    try { await request('/auth/sessions', 'POST', { account: account.username, password: account.password }); authenticated = true; break; }
    catch (error) { if (error.status !== 401) throw error; }
  }
  assert(authenticated, 'Stored credentials rejected; no credentials changed');
  report.checks.push('Existing account login');
  const capabilities = await request('/capabilities');
  assert.equal(capabilities.features.audioTranscriptionEnabled, true);
  report.checks.push('Whisper audio capability enabled');
  const fixture = readFileSync(resolve(option('--audio')));
  assert(fixture.length < 2 * 1024 * 1024, 'Use a short synthetic WAV under 2 MiB');
  const draft = await request('/creation-drafts', 'POST', { name: 'Whisper synthetic release verification', description: 'Synthetic audio only; not a real project.' });
  report.draftId = draft.id;
  report.fileId = randomUUID();
  let current = await request(`/creation-drafts/${draft.id}/files/${report.fileId}?expectedRevision=${draft.revision}&name=synthetic-speech.wav`, 'PUT', fixture, true);
  const deadline = Date.now() + 60000;
  for (;;) {
    const file = current.files.find(item => item.id === report.fileId);
    if (file?.mediaJobId) report.jobId = file.mediaJobId;
    report.finalPhase = file?.audio?.phase ?? null;
    if (file?.audio?.phase === 'ready') {
      assert(file.audio.transcriptAvailable);
      assert(file.audio.qualityScore >= 0.85);
      assert(file.textReady && file.mediaSummary?.complete);
      report.checks.push('Real Whisper transcript saved', 'Quality gate accepted before text summary', 'Complete summary reused in draft');
      report.result = 'PASS';
      break;
    }
    if (file?.audio?.phase === 'waiting_config') {
      assert(file.audio.transcriptAvailable);
      assert.equal(file.textReady, false);
      assert.equal(file.mediaSummary, null);
      report.checks.push('Real Whisper transcript saved', 'Rejected transcript retained without a false summary', 'Unconfigured Gemini waits for explicit continuation');
      report.limitations.push('The quality gate selected Gemini fallback. Configure Gemini in the administrator page before verifying real fallback.');
      report.result = 'PASS_WAITING_FALLBACK';
      break;
    }
    if (['failed', 'unknown'].includes(file?.audio?.phase) || file?.mediaStatus === 'failed') throw new Error('Audio processing failed; existing job retained for diagnosis');
    if (Date.now() >= deadline) {
      report.result = 'PENDING';
      report.limitations.push('One-minute verification window expired; original job retained and no duplicate paid task submitted.');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    current = await request(`/creation-drafts/${draft.id}`);
  }
  // Only cancel a terminal/waiting fixture. Never interrupt a still-running paid task.
  if (report.result !== 'PENDING') {
    current = await request(`/creation-drafts/${draft.id}`);
    await request(`/creation-drafts/${draft.id}/state`, 'POST', { expectedRevision: current.revision, status: 'cancelled' });
    report.checks.push('Synthetic private draft cancelled; no real project created');
  }
} catch (error) {
  report.result = 'FAILED';
  report.limitations.push(error.message);
  process.exitCode = 1;
} finally {
  if (cookie) { try { await request('/auth/session', 'DELETE'); } catch { /* Report does not depend on logout availability. */ } }
  writeFileSync(resolve(output, 'production-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
