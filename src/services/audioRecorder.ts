/**
 * Microphone recording for DeepSeek ASR, which only accepts 16-bit PCM WAV or
 * Ogg Opus. MediaRecorder with `audio/ogg;codecs=opus` is the preferred path;
 * when the runtime doesn't support that container we capture raw PCM and wrap
 * it in a WAV header ourselves (Chromium never offers MediaRecorder-wav, so
 * the fallback is the only way to stay within the accepted formats).
 *
 * Platform note: desktop Windows/macOS webviews grant microphone access after
 * the OS-level prompt. Packaged Apple builds get NSMicrophoneUsageDescription
 * from src-tauri/Info.plist (merged by Tauri), and the Android build injects
 * RECORD_AUDIO + MODIFY_AUDIO_SETTINGS into the generated manifest in the
 * release workflow — wry then drives the WebView grant and the OS prompt.
 */
export interface RecordingSession {
  /** Resolves with the recorded blob once stop() is called. */
  stop: () => Promise<{ blob: Blob; seconds: number }>;
  /** Discards the recording and releases the microphone immediately. */
  cancel: () => void;
}

const startPcmRecording = async (stream: MediaStream): Promise<RecordingSession> => {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally available; an
  // AudioWorklet needs a separate module file which complicates bundling.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let samples = 0;
  const startedAt = Date.now();
  let stopped = false;
  processor.onaudioprocess = (e) => {
    if (stopped) return;
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    samples += input.length;
  };
  source.connect(processor);
  // Muted destination keeps the processor pulling without echoing audio out.
  processor.connect(ctx.destination);

  const cleanup = () => {
    stopped = true;
    stream.getTracks().forEach(t => t.stop());
    try { processor.disconnect(); source.disconnect(); } catch {}
    ctx.close().catch(() => {});
  };

  const encodeWav = (): Blob => {
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, ctx.sampleRate, true);
    view.setUint32(28, ctx.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples * 2, true);
    let offset = 44;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  };

  return {
    stop: () => new Promise((resolve) => {
      const seconds = (Date.now() - startedAt) / 1000;
      // Let the last buffered block flush before tearing down the graph.
      setTimeout(() => {
        cleanup();
        resolve({ blob: encodeWav(), seconds });
      }, 120);
    }),
    cancel: () => cleanup(),
  };
};

const startMediaRecorderRecording = async (stream: MediaStream): Promise<RecordingSession> => {
  const mime = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
    ? 'audio/ogg;codecs=opus'
    : 'audio/ogg';
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start();
  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const type = recorder.mimeType || mime;
        resolve({ blob: new Blob(chunks, { type }), seconds: (Date.now() - startedAt) / 1000 });
      };
      recorder.stop();
    }),
    cancel: () => {
      try { recorder.stop(); } catch {}
      stream.getTracks().forEach(t => t.stop());
    },
  };
};

export const startRecording = async (): Promise<RecordingSession> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
    return startMediaRecorderRecording(stream);
  }
  return startPcmRecording(stream);
};
