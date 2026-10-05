import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Volume2 } from 'lucide-react';
import { projectPath } from '../api/client';
import { captureMicrophone, pcmBase64, type MicrophoneCapture } from './rehearsalPcm';
import { speakLocal, defaultLocalSpeech, type LocalSpeechPlayback } from './localSpeech';
import { authenticatedVoicePath, voiceRequest, type VoiceConfig, type VoiceSession } from './rehearsalVoiceApi';

type Phase = 'idle' | 'connecting' | 'recording' | 'finalizing';
export function RehearsalVoicePanel({ projectId, rehearsalId, sequence, questionText = '', enabled, initialVoiceMode = false, onModeChange, onTranscriptFinal, onBusyChange }: {
  projectId: string; rehearsalId: string; sequence: number; questionText?: string; enabled: boolean; initialVoiceMode?: boolean; onModeChange?: (voice: boolean) => void; onTranscriptFinal: (text: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const prefix = projectPath(projectId, `/rehearsals/${encodeURIComponent(rehearsalId)}`);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [voice, setVoice] = useState(initialVoiceMode);
  const [phase, setPhase] = useState<Phase>('idle');
  const [partial, setPartial] = useState('');
  const [finalText, setFinalText] = useState('');
  const [notice, setNotice] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const resources = useRef<{ controller?: AbortController; socket?: WebSocket; capture?: MicrophoneCapture; timeout?: ReturnType<typeof setTimeout>; sessionId?: string }>({});
  const localPlayback = useRef<LocalSpeechPlayback | null>(null);
  const generation = useRef(0), failures = useRef(0), previousSession = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onTranscriptFinal, onBusyChange, onModeChange });
  const lastBusy = useRef(false);
  useEffect(() => { callbacks.current = { onTranscriptFinal, onBusyChange, onModeChange }; }, [onTranscriptFinal, onBusyChange, onModeChange]);
  useEffect(() => {
    const busy = phase !== 'idle' || speaking || synthesizing;
    if (lastBusy.current !== busy) { lastBusy.current = busy; callbacks.current.onBusyChange(busy); }
  }, [phase, speaking, synthesizing]);

  const release = () => {
    generation.current++;
    const current = resources.current; resources.current = {};
    clearTimeout(current.timeout); current.capture?.stop(); current.controller?.abort(); current.socket?.close();
    if (current.sessionId) void voiceRequest(`${prefix}/voice-sessions/${encodeURIComponent(current.sessionId)}/close`, undefined, {}).catch(() => undefined);
    localPlayback.current?.cancel(); localPlayback.current = null;
    lastBusy.current = false; callbacks.current.onBusyChange(false);
  };
  const releaseRef = useRef(release);
  useEffect(() => { releaseRef.current = release; });
  useEffect(() => {
    const controller = new AbortController();
    void voiceRequest<VoiceConfig>(`${prefix}/voice`, controller.signal).then(setConfig).catch(error => {
      if (!controller.signal.aborted) { setVoice(false); callbacks.current.onModeChange?.(false); setNotice(error instanceof Error ? error.message : '语音配置读取失败，可继续文字回答。'); }
    });
    return () => { controller.abort(); releaseRef.current(); };
  }, [prefix]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    if (!enabled) {
      releaseRef.current(); setVoice(false); callbacks.current.onModeChange?.(false); setPhase('idle'); setSpeaking(false); setSynthesizing(false); setPartial('');
    }
  }, [enabled]);
  useEffect(() => {
    if (config && (!config.ready || config.mode === 'text')) { setVoice(false); callbacks.current.onModeChange?.(false); }
  }, [config]);
  useEffect(() => {
    setPhase('idle'); setSpeaking(false); setSynthesizing(false); setPartial(''); setFinalText('');
    previousSession.current = undefined; failures.current = 0; setRetryAt(0);
    return () => { releaseRef.current(); };
  }, [questionText, sequence]);

  const fallback = (message: string, countFailure = true) => {
    if (countFailure) failures.current++;
    release(); setVoice(false); callbacks.current.onModeChange?.(false); setPhase('idle'); setSpeaking(false); setSynthesizing(false); setPartial('');
    setRetryAt(Date.now() + 60000); setClock(Date.now());
    setNotice(message);
  };
  const start = async () => {
    if (!enabled || !voice || !config?.ready || config.mode !== 'voice-with-text-fallback' || phase !== 'idle' || speaking || synthesizing || Date.now() < retryAt) return;
    if (failures.current >= 3) { failures.current = 0; previousSession.current = undefined; }
    release(); const token = generation.current, controller = new AbortController(); resources.current.controller = controller;
    let audioSequence = 0, started = false, gotAudio = false;
    setNotice(''); setPartial(''); setPhase('connecting');
    lastBusy.current = true; callbacks.current.onBusyChange(true);
    try {
      // Permission is only requested in direct response to this button; audio is buffered nowhere before provider readiness.
      const capture = await captureMicrophone(frame => {
        const socket = resources.current.socket;
        if (token !== generation.current || !started || socket?.readyState !== WebSocket.OPEN) return;
        const samples = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        for (let index = 0; index < frame.byteLength; index += 2) if (Math.abs(samples.getInt16(index, true)) > 100) { gotAudio = true; break; }
        if (socket.bufferedAmount > 16000 * 2 * 5) { fallback('音频发送阻塞。'); return; }
        socket.send(JSON.stringify({ type: 'audio', sequence: ++audioSequence, data: pcmBase64(frame) }));
      }, controller.signal, () => { if (token === generation.current) fallback('麦克风已断开。'); });
      if (token !== generation.current) { capture.stop(); return; }
      resources.current.capture = capture;
      const session = await voiceRequest<VoiceSession>(`${prefix}/voice-sessions`, controller.signal, { sequence, ...(previousSession.current ? { retryOfSessionId: previousSession.current } : {}) });
      if (token !== generation.current) return;
      previousSession.current = session.sessionId; resources.current.sessionId = session.sessionId;
      const path = authenticatedVoicePath(session.webSocketPath, prefix);
      const url = new URL(path, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url); resources.current.socket = socket;
      const seen = new Set<number>();
      resources.current.timeout = setTimeout(() => { if (token === generation.current) fallback('语音连接超时。'); }, 15000);
      socket.onmessage = event => {
        if (token !== generation.current) return;
        try {
          const message = JSON.parse(String(event.data)) as { type: string; text?: string; sequence?: number; message?: string };
          if (message.type === 'ready' && !started) {
            started = true; clearTimeout(resources.current.timeout); socket.send(JSON.stringify({ type: 'start' })); setPhase('recording');
            resources.current.timeout = setTimeout(() => { if (token === generation.current && !gotAudio) fallback('未检测到音频输入。'); }, 15000);
          } else if (message.type === 'partial' && typeof message.text === 'string') { gotAudio = true; setPartial(message.text); }
          else if (message.type === 'final' && typeof message.text === 'string' && Number.isInteger(message.sequence) && !seen.has(message.sequence!)) {
            seen.add(message.sequence!); gotAudio = true; setPartial(''); const text = message.text.trim();
            if (text) { setFinalText(current => current ? `${current}\n${text}` : text); callbacks.current.onTranscriptFinal(text); }
          } else if (message.type === 'complete') { failures.current = 0; previousSession.current = undefined; release(); setPhase('idle'); setPartial(''); setNotice('转录完成，请核对和编辑下方回答后提交。'); }
          else if (message.type === 'error') fallback(message.message || '实时转录失败。');
        } catch { fallback('实时转录返回了无效信息。'); }
      };
      socket.onerror = () => { if (token === generation.current) fallback('语音连接失败。'); };
      socket.onclose = () => { if (token === generation.current) fallback('语音连接中断。'); };
    } catch (error) {
      if (token === generation.current) fallback(error instanceof DOMException && error.name === 'NotAllowedError' ? '麦克风权限被拒绝。' : error instanceof Error ? error.message : '麦克风或语音服务不可用。', !(error instanceof DOMException && error.name === 'NotAllowedError'));
    }
  };

  const stop = async () => {
    if (phase !== 'recording') return;
    const token = generation.current;
    setPhase('finalizing'); clearTimeout(resources.current.timeout);
    try {
      await resources.current.capture?.stop(true);
      if (token !== generation.current) return;
      resources.current.capture = undefined;
      resources.current.socket?.send(JSON.stringify({ type: 'stop' }));
      resources.current.timeout = setTimeout(() => { if (token === generation.current) fallback('等待最终字幕超过 15 秒。'); }, 15000);
    } catch { if (token === generation.current) fallback('停止音频采集失败。'); }
  };
  const play = async () => {
    if (!enabled || phase !== 'idle' || synthesizing || speaking || !questionText.trim()) return;
    const token = generation.current;
    setSynthesizing(true); setNotice('');
    lastBusy.current = true; callbacks.current.onBusyChange(true);
    // Older cloud-shaped settings are ignored: local speech has safe local defaults.
    const settings = config?.speech?.provider === 'system-local' ? config.speech : defaultLocalSpeech;
    const playback = speakLocal(questionText, settings, () => {
      if (token === generation.current) { setSynthesizing(false); setSpeaking(true); }
    });
    localPlayback.current = playback;
    try { await playback.finished; }
    catch (error) {
      if (token === generation.current) {
        release(); setVoice(false); callbacks.current.onModeChange?.(false); setSynthesizing(false); setSpeaking(false);
        setNotice(error instanceof Error ? error.message : '系统本地朗读失败，可继续文字回答。');
      }
    } finally {
      if (token === generation.current) { localPlayback.current = null; setSynthesizing(false); setSpeaking(false); }
    }
  };
  const stopSpeech = () => { release(); setSynthesizing(false); setSpeaking(false); };
  const switchMode = (next: boolean) => { release(); setVoice(next); onModeChange?.(next); setPhase('idle'); setSpeaking(false); setSynthesizing(false); setPartial(''); };
  const cooldown = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  return <div className="ai-workflow-note" aria-label="语音答辩控制">
    <div className="ai-workflow-actions"><button type="button" className="button button-quiet button-small" aria-pressed={!voice} onClick={() => switchMode(false)}>文字回答</button><button type="button" className="button button-quiet button-small" aria-pressed={voice} disabled={!enabled || !config?.ready || config.mode !== 'voice-with-text-fallback'} onClick={() => switchMode(true)}>语音回答</button></div>
    <p>两方轮流答辩：实时转录 → 核对文字 → 现有文字模型处理；问题由系统本地 TTS 朗读。语音失败可继续文字对话。</p>
    {(!config?.ready || config.mode === 'text') && <p role="status">{config?.reason || '当前未启用实时语音策略，请使用文字回答。'}</p>}
    <div className="ai-workflow-actions"><button type="button" className="button button-quiet button-small" onClick={() => void play()} disabled={!enabled || !questionText.trim() || phase !== 'idle' || speaking || synthesizing}><Volume2 size={14}/>{synthesizing ? '正在加载系统声音' : speaking ? '正在朗读问题' : '播放问题'}</button>
      {(speaking || synthesizing) && <button type="button" className="button button-quiet button-small" onClick={stopSpeech}>停止朗读</button>}
    </div>
    {voice && <div className="stack">
      <div className="ai-workflow-actions">
        {phase === 'recording' ? <button type="button" className="button button-quiet button-small" onClick={() => void stop()}><Square size={14}/>停止并完成转录</button> : <button type="button" className="button button-primary button-small" onClick={() => void start()} disabled={!enabled || !config?.ready || config.mode !== 'voice-with-text-fallback' || phase !== 'idle' || speaking || synthesizing || cooldown > 0}><Mic size={14}/>{phase === 'connecting' ? '正在连接语音' : phase === 'finalizing' ? '等待最终字幕' : cooldown ? `${cooldown} 秒后可继续` : previousSession.current ? '手动继续语音' : '开始录音'}</button>}
        {phase === 'connecting' || phase === 'finalizing' ? <button type="button" className="button button-quiet button-small" onClick={() => switchMode(false)}>取消并转文字</button> : null}
      </div>
      {partial && <p role="status">临时字幕（尚未写入回答）：{partial}</p>}
    </div>}
    {finalText && <p style={{ whiteSpace: 'pre-wrap' }}>已确认字幕：{finalText}</p>}
    {(voice || finalText) && <p>停止录音并完成转录后，请核对下方回答；不会自动提交。回答最多 8000 字，超出部分保留在字幕中供整理。</p>}
    {notice && <p role="status" style={{whiteSpace:'pre-wrap'}}>{notice}</p>}
  </div>;
}
