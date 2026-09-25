import type { AizuchiClip } from './ipc'

/**
 * The repertoire of the aizuchi bank. The categories follow the classes of the aizuchi classifier
 * (aizuchi-classifier.ts). The repertoire and the weights from `flow` through `work` come from a
 * frequency analysis of a real conversation corpus (33 Google Meet meetings, about 30 hours), where
 * the doubled forms "うんうん" and "はいはい" carry most of the traffic. The check, empathy, cheer,
 * surprise and correct entries were chosen by hand.
 *
 * This file imports types only, so that the script that pre-renders the Qwen3-TTS clips can load it
 * with Node's type stripping.
 */

export interface AizuchiDef {
  text: string
  category: AizuchiClip['category']
  /** The selection weight, taken from the frequency in the corpus. */
  weight: number
  /** An aizuchi is spoken fast and light, the way it sounds in the corpus. */
  speedScale?: number
  volumeScale?: number
}

export const AIZUCHI_BANK: AizuchiDef[] = [
  // Flow clips are pure backchannels that signal "go on", and they play quiet and fast.
  { text: 'うん。', category: 'flow', weight: 5, speedScale: 1.2, volumeScale: 0.8 },
  { text: 'うんうん。', category: 'flow', weight: 4, speedScale: 1.2, volumeScale: 0.8 },
  { text: 'はい。', category: 'flow', weight: 3, speedScale: 1.2, volumeScale: 0.8 },
  { text: 'はいはい。', category: 'flow', weight: 3, speedScale: 1.2, volumeScale: 0.8 },
  // Understanding, in reply to something the user shares or reports.
  { text: 'なるほど。', category: 'understand', weight: 5, speedScale: 1.1 },
  { text: 'なるほどなるほど。', category: 'understand', weight: 3, speedScale: 1.15 },
  { text: 'あ、そういうことですね。', category: 'understand', weight: 2, speedScale: 1.1 },
  { text: 'そっか。', category: 'understand', weight: 2, speedScale: 1.1 },
  { text: '確かに。', category: 'agree', weight: 4, speedScale: 1.1 },
  { text: 'ですよね。', category: 'agree', weight: 3, speedScale: 1.1 },
  { text: 'あ、そうですね。', category: 'agree', weight: 3, speedScale: 1.1 },
  // Acknowledgement, in reply to a request or an instruction.
  { text: 'あ、はい。', category: 'ack', weight: 4, speedScale: 1.15 },
  { text: '了解です。', category: 'ack', weight: 3, speedScale: 1.1 },
  { text: 'あ、わかりました。', category: 'ack', weight: 2, speedScale: 1.1 },
  { text: 'はい、オッケーです。', category: 'ack', weight: 2, speedScale: 1.1 },
  // A short reply to a check such as "〜だっけ" ("it was …, right?"), which goes straight into the
  // answer instead of sounding like thinking.
  { text: 'えっと、', category: 'check', weight: 4, speedScale: 1.1 },
  { text: 'あー、はい。', category: 'check', weight: 3, speedScale: 1.1 },
  { text: 'あ、それは', category: 'check', weight: 2, speedScale: 1.1 },
  // Thinking, in reply to a question.
  { text: 'うーん。', category: 'think', weight: 3, speedScale: 1.05 },
  { text: 'そうですね、', category: 'think', weight: 4, speedScale: 1.05 },
  { text: 'えっとですね、', category: 'think', weight: 3, speedScale: 1.05 },
  { text: 'あー、はい。', category: 'think', weight: 2, speedScale: 1.1 },
  // Announcing work, when a search, a lookup or an agent job is expected.
  { text: 'ちょっと見てみますね。', category: 'work', weight: 3, speedScale: 1.05 },
  { text: '調べてみますね。', category: 'work', weight: 3, speedScale: 1.05 },
  { text: '確認しますね。', category: 'work', weight: 2, speedScale: 1.05 },
  { text: 'あ、ちょっと待ってくださいね。', category: 'work', weight: 1, speedScale: 1.05 },
  { text: '少々お待ちください。', category: 'work', weight: 1, speedScale: 1.05 },
  // Empathy, in reply to trouble, tiredness or a complaint. The clip is chosen by the direction of the
  // predicted feeling, and these weights do not come from the corpus.
  { text: 'あー。', category: 'empathy', weight: 3, speedScale: 1.0 },
  { text: 'そっかぁ。', category: 'empathy', weight: 3, speedScale: 1.0 },
  { text: 'それは大変ですね。', category: 'empathy', weight: 2, speedScale: 1.05 },
  { text: 'うーん、そうですか。', category: 'empathy', weight: 1, speedScale: 1.0 },
  // Cheering, in reply to good news.
  { text: 'おー。', category: 'cheer', weight: 3, speedScale: 1.05 },
  { text: 'いいですね。', category: 'cheer', weight: 3, speedScale: 1.1 },
  { text: 'おお、すごい。', category: 'cheer', weight: 2, speedScale: 1.1 },
  // Surprise, in reply to unexpected information, good or bad.
  { text: 'え、そうなんですか。', category: 'surprise', weight: 3, speedScale: 1.1 },
  { text: 'えっ。', category: 'surprise', weight: 3, speedScale: 1.1 },
  { text: 'え、本当ですか。', category: 'surprise', weight: 2, speedScale: 1.1 },
  // An apology, when the user corrects a mistake of ours.
  { text: 'あ、失礼しました。', category: 'correct', weight: 3, speedScale: 1.1 },
  { text: 'あ、すみません。', category: 'correct', weight: 3, speedScale: 1.1 },
  { text: 'あ、そっちですね。', category: 'correct', weight: 2, speedScale: 1.1 }
]
