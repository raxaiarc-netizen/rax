import { KokoroTTS } from 'kokoro-js'
import { writeFileSync, statSync } from 'fs'

console.time('load')
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
})
console.timeEnd('load')

console.log('voices:', Object.keys(tts.voices).length, 'available')

console.time('synth')
const audio = await tts.generate(
  "Hello from rax. This is Kokoro running pure JavaScript, no Python anywhere. We can ship this in a DMG.",
  { voice: 'af_heart' },
)
console.timeEnd('synth')

console.log('sample_rate:', audio.sampling_rate)
console.log('audio length samples:', audio.audio.length)
const dur = audio.audio.length / audio.sampling_rate
console.log('duration:', dur.toFixed(2), 's')

audio.save('/tmp/kokoro-js-smoke.wav')
console.log('saved /tmp/kokoro-js-smoke.wav', statSync('/tmp/kokoro-js-smoke.wav').size, 'bytes')
