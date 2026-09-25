import { defineMessages } from '../message'

export const settingsPersona = defineMessages({
  title: {
    'ja-JP': 'キャラクター',
    'en-US': 'Character',
    'fr-FR': 'Personnalité',
    'de-DE': 'Charakter',
    'hi-IN': 'किरदार',
    'id-ID': 'Karakter',
    'it-IT': 'Personalità',
    'ko-KR': '캐릭터',
    'pt-BR': 'Personalidade',
    'es-419': 'Personalidad',
    'es-ES': 'Personalidad'
  },
  lead: {
    'ja-JP': 'ASIST の人柄と役割を書きます。言い回しの例ではなく、何を大切にするかを書きます。',
    'en-US': "Describe ASIST's character and role. Write what it should value, not examples of how it should speak.",
    'fr-FR': "Décrivez la personnalité et le rôle d'ASIST. Écrivez ce à quoi il doit tenir, pas des exemples de formulation.",
    'de-DE': 'Beschreiben Sie Charakter und Rolle von ASIST. Schreiben Sie, worauf es ankommen soll, nicht Beispiele dafür, wie ASIST sprechen soll.',
    'hi-IN': 'ASIST का स्वभाव और भूमिका लिखें। वह कैसे बोले इसके उदाहरण नहीं, बल्कि किस बात को अहमियत दे, यह लिखें।',
    'id-ID': 'Tuliskan watak dan peran ASIST. Tulis apa yang harus dia utamakan, bukan contoh cara bicaranya.',
    'it-IT': 'Descrivi la personalità e il ruolo di ASIST. Indica quali sono le sue priorità, non esempi di come deve parlare.',
    'ko-KR': 'ASIST의 성격과 역할을 적습니다. 말투의 예가 아니라 무엇을 중요하게 여길지를 적습니다.',
    'pt-BR': 'Descreva a personalidade e o papel do ASIST. Escreva o que ele deve valorizar, não exemplos de como deve falar.',
    'es-419': 'Describe la personalidad y el rol de ASIST. Escribe qué debe valorar, no ejemplos de cómo debe hablar.',
    'es-ES': 'Describe la personalidad y la función de ASIST. Escribe qué debe valorar, no ejemplos de cómo debe hablar.'
  },
  state: {
    default: {
      'ja-JP': '既定のキャラクターを使っています',
      'en-US': 'Using the default persona',
      'fr-FR': 'La personnalité par défaut est utilisée',
      'de-DE': 'Der Standard-Charakter ist in Gebrauch',
      'hi-IN': 'डिफ़ॉल्ट किरदार इस्तेमाल हो रहा है',
      'id-ID': 'Memakai karakter bawaan',
      'it-IT': 'È in uso la personalità predefinita',
      'ko-KR': '기본 캐릭터를 사용하고 있습니다',
      'pt-BR': 'Usando a personalidade padrão',
      'es-419': 'Se usa la personalidad predeterminada',
      'es-ES': 'Se está usando la personalidad por omisión'
    },
    edited: {
      'ja-JP': '編集したキャラクターを使っています',
      'en-US': 'Using your edited persona',
      'fr-FR': 'Votre personnalité modifiée est utilisée',
      'de-DE': 'Ihr bearbeiteter Charakter ist in Gebrauch',
      'hi-IN': 'आपका बदला हुआ किरदार इस्तेमाल हो रहा है',
      'id-ID': 'Memakai karakter yang Anda edit',
      'it-IT': 'È in uso la personalità modificata',
      'ko-KR': '편집한 캐릭터를 사용하고 있습니다',
      'pt-BR': 'Usando a personalidade que você editou',
      'es-419': 'Se usa la personalidad que editaste',
      'es-ES': 'Se está usando la personalidad que has editado'
    },
    empty: {
      'ja-JP': '空です。基本の指示だけで会話します',
      'en-US': 'Empty. Only the base instructions are used',
      'fr-FR': 'Vide. Seules les instructions de base servent à la conversation',
      'de-DE': 'Leer. Es gelten nur die Grundanweisungen',
      'hi-IN': 'खाली है। सिर्फ़ बुनियादी निर्देशों से बातचीत होगी',
      'id-ID': 'Kosong. Hanya instruksi dasar yang dipakai',
      'it-IT': 'Vuota. La conversazione usa solo le istruzioni di base',
      'ko-KR': '비어 있습니다. 기본 지시만으로 대화합니다',
      'pt-BR': 'Vazia. Só as instruções básicas são usadas',
      'es-419': 'Está vacía. Solo se usan las instrucciones básicas',
      'es-ES': 'Está vacía. Se usan solo las instrucciones básicas'
    }
  },
  text: {
    title: {
      'ja-JP': '人柄と役割',
      'en-US': 'Character and role',
      'fr-FR': 'Personnalité et rôle',
      'de-DE': 'Charakter und Rolle',
      'hi-IN': 'स्वभाव और भूमिका',
      'id-ID': 'Watak dan peran',
      'it-IT': 'Personalità e ruolo',
      'ko-KR': '성격과 역할',
      'pt-BR': 'Personalidade e papel',
      'es-419': 'Personalidad y rol',
      'es-ES': 'Personalidad y función'
    },
    description: {
      'ja-JP': '会話のたびに指示として渡します。記憶の整理では、この文章をもとに ASIST が「私について」(me.md)を書きます。',
      'en-US': 'It is given to the model at the start of every conversation. During memory curation, ASIST writes About me (me.md) from it.',
      'fr-FR': "Elle est donnée au modèle au début de chaque conversation. Pendant l'organisation de la mémoire, ASIST écrit À mon sujet (me.md) à partir de ce texte.",
      'de-DE': 'Der Text geht zu Beginn jedes Gesprächs an das Modell. Bei der Gedächtnispflege schreibt ASIST daraus „Über mich“ (me.md).',
      'hi-IN': 'यह हर बातचीत की शुरुआत में मॉडल को दिया जाता है। याददाश्त की सफ़ाई में ASIST इसी से "मेरे बारे में" (me.md) लिखता है।',
      'id-ID': 'Teks ini diberikan ke model di awal setiap percakapan. Saat penataan ingatan, ASIST menulis Tentang saya (me.md) dari teks ini.',
      'it-IT': "Viene passata al modello all'inizio di ogni conversazione. Durante il riordino della memoria, ASIST la usa per scrivere «Su di me» (me.md).",
      'ko-KR': "대화할 때마다 지시로 전달합니다. 기억 정리에서는 이 글을 바탕으로 ASIST가 '나에 대하여'(me.md)를 씁니다.",
      'pt-BR': 'É passada ao modelo no início de cada conversa. Na organização da memória, o ASIST escreve Sobre mim (me.md) a partir dela.',
      'es-419': 'Se le entrega al modelo al inicio de cada conversación. En la organización de la memoria, ASIST escribe «Acerca de mí» (me.md) a partir de este texto.',
      'es-ES': 'Se le pasa al modelo al empezar cada conversación. Al organizar la memoria, ASIST escribe “Sobre mí” (me.md) a partir de este texto.'
    },
    reset: {
      'ja-JP': '既定に戻す',
      'en-US': 'Reset to default',
      'fr-FR': 'Rétablir la valeur par défaut',
      'de-DE': 'Auf Standard zurücksetzen',
      'hi-IN': 'डिफ़ॉल्ट पर लौटाएँ',
      'id-ID': 'Kembalikan ke bawaan',
      'it-IT': 'Ripristina il testo predefinito',
      'ko-KR': '기본값으로 되돌리기',
      'pt-BR': 'Restaurar o padrão',
      'es-419': 'Restablecer',
      'es-ES': 'Restablecer'
    },
    hint: {
      'ja-JP': '入力欄から離れたときに保存します。',
      'en-US': 'Saved when you leave the field.',
      'fr-FR': 'Enregistrée quand vous quittez le champ.',
      'de-DE': 'Wird gespeichert, sobald Sie das Feld verlassen.',
      'hi-IN': 'इस खाने से बाहर जाते ही सेव हो जाता है।',
      'id-ID': 'Tersimpan saat Anda meninggalkan kolom ini.',
      'it-IT': 'Il testo viene salvato quando esci dal campo.',
      'ko-KR': '입력란에서 벗어나면 저장합니다.',
      'pt-BR': 'Salva quando você sai do campo.',
      'es-419': 'Se guarda cuando sales del campo.',
      'es-ES': 'Se guarda al salir del campo.'
    },
    label: {
      'ja-JP': 'キャラクター',
      'en-US': 'Character',
      'fr-FR': 'Personnalité',
      'de-DE': 'Charakter',
      'hi-IN': 'किरदार',
      'id-ID': 'Karakter',
      'it-IT': 'Personalità',
      'ko-KR': '캐릭터',
      'pt-BR': 'Personalidade',
      'es-419': 'Personalidad',
      'es-ES': 'Personalidad'
    },
    placeholder: {
      'ja-JP': '空のままにすると、基本の指示だけで会話します',
      'en-US': 'Left empty, only the base instructions are used',
      'fr-FR': 'Laissée vide, seules les instructions de base servent à la conversation',
      'de-DE': 'Bleibt es leer, gelten nur die Grundanweisungen',
      'hi-IN': 'खाली छोड़ने पर सिर्फ़ बुनियादी निर्देशों से बातचीत होगी',
      'id-ID': 'Kalau dibiarkan kosong, hanya instruksi dasar yang dipakai',
      'it-IT': 'Se resta vuota, la conversazione usa solo le istruzioni di base',
      'ko-KR': '비워 두면 기본 지시만으로 대화합니다',
      'pt-BR': 'Se ficar vazia, só as instruções básicas são usadas',
      'es-419': 'Si lo dejas vacío, solo se usan las instrucciones básicas',
      'es-ES': 'Si lo dejas vacío, se usan solo las instrucciones básicas'
    }
  },
  me: {
    title: {
      'ja-JP': '私について(me.md)',
      'en-US': 'About me (me.md)',
      'fr-FR': 'À mon sujet (me.md)',
      'de-DE': 'Über mich (me.md)',
      'hi-IN': 'मेरे बारे में (me.md)',
      'id-ID': 'Tentang saya (me.md)',
      'it-IT': 'Su di me (me.md)',
      'ko-KR': '나에 대하여(me.md)',
      'pt-BR': 'Sobre mim (me.md)',
      'es-419': 'Acerca de mí (me.md)',
      'es-ES': 'Sobre mí (me.md)'
    },
    description: {
      'ja-JP': '記憶の整理で ASIST 自身が書く文章です。キャラクターと合わせて、会話のたびに渡します。',
      'en-US': 'ASIST writes this text itself during memory curation. It is given to the model together with the persona.',
      'fr-FR': "ASIST écrit lui-même ce texte pendant l'organisation de la mémoire. Il est donné au modèle avec la personnalité.",
      'de-DE': 'Diesen Text schreibt ASIST bei der Gedächtnispflege selbst. Er geht zusammen mit dem Charakter an das Modell.',
      'hi-IN': 'याददाश्त की सफ़ाई में ASIST यह टेक्स्ट खुद लिखता है। यह किरदार के साथ मॉडल को दिया जाता है।',
      'id-ID': 'ASIST menulis teks ini sendiri saat penataan ingatan. Teks ini diberikan ke model bersama karakternya.',
      'it-IT': 'È un testo che ASIST scrive da sé durante il riordino della memoria. Viene passato al modello insieme alla personalità.',
      'ko-KR': '기억 정리에서 ASIST가 직접 쓰는 글입니다. 캐릭터와 함께 대화할 때마다 전달합니다.',
      'pt-BR': 'O próprio ASIST escreve este texto na organização da memória. Ele é passado ao modelo junto com a personalidade.',
      'es-419': 'ASIST escribe este texto durante la organización de la memoria. Se le entrega al modelo junto con la personalidad.',
      'es-ES': 'ASIST escribe este texto al organizar la memoria. Se le pasa al modelo junto con la personalidad.'
    },
    row: {
      'ja-JP': '記憶の画面で読み書きできます',
      'en-US': 'You can read and edit it in Memory',
      'fr-FR': 'Vous pouvez le lire et le modifier dans Mémoire',
      'de-DE': 'Im Gedächtnis können Sie ihn lesen und bearbeiten',
      'hi-IN': 'इसे "याददाश्त" में पढ़ और बदल सकते हैं',
      'id-ID': 'Anda bisa membaca dan mengeditnya di Ingatan',
      'it-IT': 'Si può leggere e modificare nella pagina «Memoria»',
      'ko-KR': '기억 화면에서 읽고 편집할 수 있습니다',
      'pt-BR': 'Você pode ler e editar em Memória',
      'es-419': 'Puedes leerlo y editarlo en Memoria',
      'es-ES': 'Puedes leerlo y editarlo en Memoria'
    },
    hint: {
      'ja-JP': '「私について」の項目にあります。',
      'en-US': 'It is under About me.',
      'fr-FR': 'Il se trouve sous À mon sujet.',
      'de-DE': 'Er steht unter „Über mich“.',
      'hi-IN': 'यह "मेरे बारे में" के नीचे है।',
      'id-ID': 'Ada di bagian Tentang saya.',
      'it-IT': 'Si trova sotto «Su di me».',
      'ko-KR': "'나에 대하여' 항목에 있습니다.",
      'pt-BR': 'Está no item Sobre mim.',
      'es-419': 'Está en la sección «Acerca de mí».',
      'es-ES': 'Está en el apartado “Sobre mí”.'
    },
    open: {
      'ja-JP': '記憶を開く',
      'en-US': 'Open Memory',
      'fr-FR': 'Ouvrir Mémoire',
      'de-DE': 'Gedächtnis öffnen',
      'hi-IN': 'याददाश्त खोलें',
      'id-ID': 'Buka Ingatan',
      'it-IT': 'Apri «Memoria»',
      'ko-KR': '기억 열기',
      'pt-BR': 'Abrir Memória',
      'es-419': 'Abrir Memoria',
      'es-ES': 'Abrir Memoria'
    }
  }
})
