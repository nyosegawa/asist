#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import OpenAI from 'openai'
import { LiveWS } from 'openai/resources/live/ws'

/**
 * Builds the voice samples the settings screen plays.
 *
 *   node scripts/gen-live-voices.mjs                    rebuilds all of them
 *   node scripts/gen-live-voices.mjs gemini-live        rebuilds one engine
 *   node scripts/gen-live-voices.mjs gpt-live willow    rebuilds one voice
 *
 * The same sentence is read by OpenAI's TTS (gpt-4o-mini-tts) for the 22 GPT-Live voices, and by Gemini's
 * TTS (gemini-2.5-flash-preview-tts) for the 30 Gemini voices; a voice the TTS does not have is recorded
 * from a GPT-Live session instead. ffmpeg turns the result into
 * src/renderer/src/assets/live-voices/<engine>/<voice>.mp3, which is what the settings screen plays, so
 * listening to a sample needs no API. Keys come from the environment or from userData/.env, as
 * OPENAI_API_KEY and GEMINI_API_KEY.
 */

const TEXT = 'こんにちは。声のテストです。今日はいい天気ですね。'
const OUT = path.resolve('src/renderer/src/assets/live-voices')
const GPT_LIVE_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cinder', 'coral', 'delta', 'echo', 'gleam', 'meridian', 'quartz', 'ripple', 'sage', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow']
const GEMINI_VOICES = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat']

function key(name) {
  if (process.env[name]) return process.env[name]
  const env = readFileSync(path.join(homedir(), 'Library/Application Support/asist/.env'), 'utf8')
  const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'))
  if (!match) throw new Error(`${name} がありません`)
  return match[1].trim()
}

/** Wraps mono PCM16 at 24 kHz in a WAV header, which is what ffmpeg is handed. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function toMp3(wavBytes, target) {
  const temp = path.join(tmpdir(), `live-voice-${process.pid}.wav`)
  writeFileSync(temp, wavBytes)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', temp, '-codec:a', 'libmp3lame', '-b:a', '48k', target])
  rmSync(temp, { force: true })
}

async function openaiTts(apiKey, voice) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: TEXT, response_format: 'mp3', instructions: '自然な日本語で、落ち着いて読む' })
  })
  if (res.status === 400) return null
  if (!res.ok) throw new Error(`openai tts ${voice}: ${res.status} ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Records a voice the TTS does not have by having a GPT-Live session read the sentence. There is no signal
 * for the end of the reading, so two seconds of silence ends the recording, and the reading itself can
 * start more than a second late.
 */
async function gptLiveCapture(apiKey, voice) {
  const client = new OpenAI({ apiKey, maxRetries: 0 })
  const socket = new LiveWS(client, { reconnect: null })
  const chunks = []
  const seen = []
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`gpt-live ${voice}: 時間切れ(届いたイベント: ${seen.join(', ')})`)), 20000)
    let quiet = null
    socket.on('event', (event) => {
      if (event.type !== 'session.output_audio.delta') seen.push(event.type)
      if (event.type === 'session.started') {
        // Silent microphone audio goes first, because commentary is sometimes not read until some audio
        // has arrived.
        const silence = Buffer.alloc(4800).toString('base64')
        for (let i = 0; i < 10; i++) socket.send({ type: 'session.input_audio.append', audio: silence })
        socket.send({ type: 'session.commentary.append', delegation_id: null, content: TEXT })
      }
      if (event.type === 'session.output_audio.delta') {
        chunks.push(Buffer.from(event.delta, 'base64'))
        if (quiet) clearTimeout(quiet)
        quiet = setTimeout(() => { clearTimeout(deadline); resolve() }, 2000)
      }
      if (event.type === 'error') { clearTimeout(deadline); reject(new Error(`gpt-live ${voice}: ${event.error.message}`)) }
    })
    socket.on('error', (error) => { clearTimeout(deadline); reject(error) })
    socket.send({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice } },
        delegation: { type: 'client' },
        instructions: '与えられた文をそのまま日本語で読み上げる。言い足さない。'
      }
    })
  })
  try { socket.send({ type: 'session.close' }) } catch {}
  socket.close()
  return wav(Buffer.concat(chunks), 24000)
}

async function geminiTts(apiKey, voice) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `次の文を自然な日本語で読み上げる: ${TEXT}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
    })
  })
  if (!res.ok) throw new Error(`gemini tts ${voice}: ${res.status} ${await res.text()}`)
  const body = await res.json()
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!part) throw new Error(`gemini tts ${voice}: 音声が無い ${JSON.stringify(body).slice(0, 200)}`)
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000)
  return wav(Buffer.from(part.inlineData.data, 'base64'), rate)
}

const only = process.argv[2]
const onlyVoice = process.argv[3]
if (!only || only === 'gpt-live') {
  const apiKey = key('OPENAI_API_KEY')
  mkdirSync(path.join(OUT, 'gpt-live'), { recursive: true })
  for (const voice of GPT_LIVE_VOICES.filter((v) => !onlyVoice || v === onlyVoice)) {
    const target = path.join(OUT, 'gpt-live', `${voice}.mp3`)
    const mp3 = await openaiTts(apiKey, voice)
    if (mp3) {
      writeFileSync(target, mp3)
      console.log(`gpt-live ${voice}: tts`)
    } else {
      toMp3(await gptLiveCapture(apiKey, voice), target)
      console.log(`gpt-live ${voice}: live capture`)
    }
  }
}
if (!only || only === 'gemini-live') {
  const apiKey = key('GEMINI_API_KEY')
  mkdirSync(path.join(OUT, 'gemini-live'), { recursive: true })
  for (const voice of GEMINI_VOICES.filter((v) => !onlyVoice || v === onlyVoice)) {
    toMp3(await geminiTts(apiKey, voice), path.join(OUT, 'gemini-live', `${voice}.mp3`))
    console.log(`gemini-live ${voice}: tts`)
  }
}
