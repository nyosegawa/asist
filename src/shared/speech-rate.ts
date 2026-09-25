/**
 * How long a text takes to read aloud, for the progress of the karaoke subtitle before the real
 * length of the audio is known. The rates of a synthesizer were measured in Japanese, where one
 * character is one syllable; the same number applied to a language written in letters would make a
 * sentence three times too long, so those languages get a rate of their own.
 */

/** Characters that are read as one syllable each, whatever language the sentence around them is in. */
const SYLLABIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * A text with any of those characters is read at the rate measured in Japanese. A Japanese sentence
 * normally holds Latin letters as well, so requiring all of it to be syllabic would put every such
 * sentence on the wrong rate; an English sentence quoting one Chinese character, the opposite case,
 * only makes a progress bar run slow.
 */
export const readsAsSyllables = (text: string): boolean => SYLLABIC.test(text)

/**
 * Milliseconds per character for a language written in letters, assuming 150 words a minute, which
 * is a normal speaking rate, and six characters per word counting the space: 15 characters a second.
 */
export const LETTER_MS_PER_CHARACTER = 67

/** The milliseconds a text takes to read, from the rate measured for the syllabic scripts. */
export const estimateSpeechMs = (text: string, syllabicMsPerCharacter: number): number =>
  text.length * (readsAsSyllables(text) ? syllabicMsPerCharacter : LETTER_MS_PER_CHARACTER)
