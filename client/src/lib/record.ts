/**
 * Capture one spoken utterance and hand back a 16 kHz mono WAV.
 *
 * The resampling happens HERE rather than on the server on purpose. A phone
 * records webm/opus at 48 kHz; Whisper wants 16 kHz mono PCM. Converting on the
 * server means an ffmpeg subprocess for every utterance, while the browser
 * already ships a decoder and a resampler in `AudioContext`. This costs the
 * phone a few milliseconds and costs the property's single GPU box nothing.
 *
 * Nothing here uses `SpeechRecognition`. It is more accurate and much faster
 * than what the server can do — because in Chrome it works by uploading the
 * audio to Google. A hotel guest's voice, room number and complaint going to a
 * third party is a worse disclosure than any text this product already argues
 * about, so the audio goes to the hotel's own machine and nowhere else.
 */

export type Recorder = {
  /** Resolve with the recorded WAV, or null if nothing usable was captured. */
  stop: () => Promise<Blob | null>;
  /** Abandon the recording and release the microphone. */
  cancel: () => void;
  /** 0-1, for a level meter. Reads the live analyser; safe to poll on a frame. */
  level: () => number;
};

export const TARGET_RATE = 16000;

export function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined" &&
    (typeof window.AudioContext !== "undefined" ||
      typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined")
  );
}

function audioContext(rate?: number): AudioContext {
  const Ctor =
    window.AudioContext ??
    ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  return rate ? new Ctor({ sampleRate: rate }) : new Ctor();
}

/**
 * Pick a container the browser will actually give us.
 *
 * Safari produces mp4/aac and rejects the webm types Chrome prefers; passing an
 * unsupported mimeType throws rather than falling back. The empty string lets
 * the browser choose, which is the correct last resort because the audio is
 * decoded by that same browser a moment later.
 */
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const t of candidates) {
    if (window.MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return "";
}

export async function startRecording(maxSeconds = 30): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mimeType = pickMimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  /* A live analyser, only so the UI can show that the mic is hearing something.
     A guest who has denied the mic at the OS level gets a granted permission and
     total silence, and a flat meter is the only honest way to show that. */
  const meterCtx = audioContext();
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  meterCtx.createMediaStreamSource(stream).connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);

  rec.start();

  /* A guest who taps record and puts the phone in their pocket must not hold a
     microphone open forever. Whisper's own window is 30s anyway. */
  const cap = window.setTimeout(() => {
    if (rec.state === "recording") rec.stop();
  }, maxSeconds * 1000);

  const release = () => {
    window.clearTimeout(cap);
    stream.getTracks().forEach((t) => t.stop());
    void meterCtx.close().catch(() => {});
  };

  return {
    level() {
      analyser.getByteTimeDomainData(bins);
      let peak = 0;
      for (let i = 0; i < bins.length; i++) peak = Math.max(peak, Math.abs(bins[i] - 128) / 128);
      return peak;
    },
    cancel() {
      if (rec.state !== "inactive") rec.stop();
      release();
    },
    async stop() {
      const done = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      if (rec.state !== "inactive") rec.stop();
      await done;
      release();

      if (!chunks.length) return null;
      const encoded = new Blob(chunks, { type: mimeType || "audio/webm" });
      const bytes = await encoded.arrayBuffer();
      if (bytes.byteLength === 0) return null;

      /* Decode at the device's own rate, then resample offline. Constructing the
         decode context at 16 kHz directly is tempting and wrong: Firefox ignores
         sampleRate on decodeAudioData, so the resample has to be explicit. */
      const decodeCtx = audioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await decodeCtx.decodeAudioData(bytes);
      } finally {
        void decodeCtx.close().catch(() => {});
      }
      const mono = await toMono16k(decoded);
      return encodeWav(mono, TARGET_RATE);
    },
  };
}

/** Downmix to one channel and resample to 16 kHz using the browser's resampler. */
export async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil((buffer.duration * TARGET_RATE) | 0));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const out = await offline.startRendering();
  return out.getChannelData(0);
}

/**
 * Wrap PCM in a 44-byte canonical WAV header.
 *
 * Uncompressed and 16-bit because that is exactly what `server/stt.ts` parses —
 * the server deliberately has no codec of its own, so anything cleverer here
 * would be rejected there.
 */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    /* Clamp before scaling. A sample above 1.0 — which a phone with aggressive
       auto-gain does produce — wraps to a large negative int16 and lands in the
       audio as a click loud enough to cost the model the surrounding word. */
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
