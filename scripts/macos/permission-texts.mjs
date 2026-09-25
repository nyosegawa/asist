#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Writes the texts macOS shows when it asks for the microphone and the calendars, one InfoPlist.strings
 * per language, into build/lproj/. electron-builder copies each into the app's folder of that language.
 * macOS picks the text by the language of the system, not by the app's own setting, and falls back to the
 * English text in Info.plist for a language that is not here.
 *
 * They live here and not in the interface dictionary because nothing in the app reads them: the system
 * does, from files that have to exist before the app first runs.
 */

/** The folder name Electron uses for each locale of the interface. */
const LPROJ = {
  'ja-JP': 'ja',
  'en-US': 'en',
  'fr-FR': 'fr',
  'de-DE': 'de',
  'hi-IN': 'hi',
  'id-ID': 'id',
  'it-IT': 'it',
  'ko-KR': 'ko',
  'pt-BR': 'pt_BR',
  'es-419': 'es_419',
  'es-ES': 'es'
}

const TEXTS = {
  NSMicrophoneUsageDescription: {
    'ja-JP': '音声でアシスタントと会話するためにマイクを使用します。',
    'en-US': 'ASIST uses the microphone so that you can talk with the assistant.',
    'fr-FR': "ASIST utilise le micro pour que vous puissiez parler avec l'assistant.",
    'de-DE': 'ASIST verwendet das Mikrofon, damit Sie mit dem Assistenten sprechen können.',
    'hi-IN': 'ASIST माइक्रोफ़ोन का इस्तेमाल इसलिए करता है ताकि आप असिस्टेंट से बोलकर बात कर सकें।',
    'id-ID': 'ASIST memakai mikrofon agar Anda bisa berbicara dengan asisten.',
    'it-IT': "ASIST usa il microfono per farti parlare con l'assistente.",
    'ko-KR': 'ASIST는 음성으로 어시스턴트와 대화할 수 있도록 마이크를 사용합니다.',
    'pt-BR': 'O ASIST usa o microfone para que você possa conversar com o assistente.',
    'es-419': 'ASIST usa el micrófono para que puedas hablar con el asistente.',
    'es-ES': 'ASIST usa el micrófono para que puedas hablar con el asistente.'
  },
  NSCalendarsFullAccessUsageDescription: {
    'ja-JP': '選択したカレンダーの予定を表示し、確認した予定を追加・変更・削除します。',
    'en-US': 'ASIST shows the events of the calendars you choose, and adds, changes or deletes an event only after you confirm it.',
    'fr-FR': "ASIST affiche les événements des calendriers que vous choisissez, et n'ajoute, ne modifie ou ne supprime un événement qu'après votre confirmation.",
    'de-DE': 'ASIST zeigt die Termine der Kalender, die Sie auswählen, und fügt einen Termin erst nach Ihrer Bestätigung hinzu, ändert oder löscht ihn.',
    'hi-IN': 'ASIST आपके चुने हुए कैलेंडर के इवेंट दिखाता है, और कोई इवेंट आपकी पुष्टि के बाद ही जोड़ता, बदलता या मिटाता है।',
    'id-ID': 'ASIST menampilkan acara dari kalender yang Anda pilih, dan hanya menambah, mengubah, atau menghapus acara setelah Anda mengonfirmasinya.',
    'it-IT': 'ASIST mostra gli eventi dei calendari che scegli e aggiunge, modifica o elimina un evento solo dopo la tua conferma.',
    'ko-KR': 'ASIST는 선택한 캘린더의 일정을 표시하고, 사용자가 확인한 뒤에만 일정을 추가, 변경 또는 삭제합니다.',
    'pt-BR': 'O ASIST mostra os eventos dos calendários que você escolher e só adiciona, altera ou apaga um evento depois da sua confirmação.',
    'es-419': 'ASIST muestra los eventos de los calendarios que elijas y solo agrega, cambia o elimina un evento después de que lo confirmes.',
    'es-ES': 'ASIST muestra los eventos de los calendarios que elijas y solo añade, cambia o elimina un evento después de que lo confirmes.'
  }
}

const out = path.resolve(import.meta.dirname, '../../build/lproj')
rmSync(out, { recursive: true, force: true })
for (const [locale, folder] of Object.entries(LPROJ)) {
  const lines = Object.entries(TEXTS).map(([key, texts]) => {
    if (!texts[locale]) throw new Error(`${key} has no text for ${locale}`)
    return `"${key}" = "${texts[locale].replaceAll('\\', '\\\\').replaceAll('"', '\\"')}";`
  })
  mkdirSync(path.join(out, `${folder}.lproj`), { recursive: true })
  // macOS reads a .strings file as UTF-16 with a byte order mark, or as UTF-8 since macOS 10.x; UTF-16 is the form every version takes.
  writeFileSync(path.join(out, `${folder}.lproj`, 'InfoPlist.strings'), Buffer.from(`﻿${lines.join('\n')}\n`, 'utf16le'))
}
console.log(`permission texts: ${Object.keys(LPROJ).length} languages written to build/lproj`)
