import { KokoroTTS, env } from 'kokoro-js';
import { join } from 'path';
import { writeFileSync } from 'fs';

env.cacheDir = join(process.cwd(), 'models', 'hf');
env.allowLocalModels = true;
env.allowRemoteModels = false;

console.log('Loading Kokoro-82M from local cache...');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});

const voices = tts.list_voices();
console.log('Total voices:', voices.length);
const jaVoices = voices.filter(v => v.includes('j') || v.startsWith('j'));
console.log('Japanese-prefix voices:', jaVoices.slice(0, 10));
console.log('All voice IDs (first 20):', voices.slice(0, 20));

// Quick synthesis test with Japanese
const jaVoice = jaVoices[0] || voices.find(v => v.toLowerCase().includes('ja')) || voices[0];
console.log('\nTesting synthesis with voice:', jaVoice);
const t0 = Date.now();
const out = await tts.generate('こんにちは、ヴィンパールリゾートへようこそ。', { voice: jaVoice });
const ms = Date.now() - t0;
console.log('Synthesis done in', ms, 'ms');
console.log('Output type:', typeof out, out?.constructor?.name);
console.log('Output keys:', Object.keys(out || {}));

// Save audio if it has sampling_rate + audio
if (out && out.audio && out.sampling_rate) {
  const samples = out.audio instanceof Float32Array ? out.audio : new Float32Array(out.audio);
  const rate = out.sampling_rate;
  const pcmBuf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcmBuf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  // Wrap WAV
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);
  writeFileSync('scripts/kokoro-test-ja.wav', Buffer.concat([header, pcmBuf]));
  const audioSec = samples.length / rate;
  console.log(`\nSaved: scripts/kokoro-test-ja.wav`);
  console.log(`Audio: ${audioSec.toFixed(2)}s, RTF: ${(ms/1000/audioSec).toFixed(2)}`);
}
