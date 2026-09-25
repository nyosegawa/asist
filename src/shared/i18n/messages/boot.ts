import { defineMessages } from '../message'

/** The screen shown while the app starts, and the two ways starting can fail. */
export const boot = defineMessages({
  checking: {
    'ja-JP': '設定とサービスの状態を確認しています。',
    'en-US': 'Checking the settings and the services.',
    'fr-FR': 'Vérification des réglages et des services.',
    'de-DE': 'Die Einstellungen und die Dienste werden geprüft.',
    'hi-IN': 'सेटिंग्ज़ और सेवाओं की स्थिति देखी जा रही है।',
    'id-ID': 'Memeriksa pengaturan dan layanan.',
    'it-IT': 'Controllo delle impostazioni e dei servizi in corso.',
    'ko-KR': '설정과 서비스 상태를 확인하고 있습니다.',
    'pt-BR': 'Verificando os ajustes e os serviços.',
    'es-419': 'Verificando la configuración y los servicios.',
    'es-ES': 'Comprobando los ajustes y los servicios.'
  },
  failed: {
    'ja-JP': 'ASISTを起動できませんでした',
    'en-US': "Couldn't start ASIST",
    'fr-FR': 'Impossible de démarrer ASIST',
    'de-DE': 'ASIST konnte nicht gestartet werden',
    'hi-IN': 'ASIST शुरू नहीं हो सका',
    'id-ID': 'Tidak bisa menjalankan ASIST',
    'it-IT': 'Impossibile avviare ASIST',
    'ko-KR': 'ASIST를 시작하지 못했습니다',
    'pt-BR': 'Não foi possível iniciar o ASIST',
    'es-419': 'No se pudo iniciar ASIST',
    'es-ES': 'No se ha podido iniciar ASIST'
  },
  bridgeFailed: {
    'ja-JP': 'アプリの一部を読み込めませんでした。ASISTを終了して起動し直してください。直らない場合はアプリを入れ直してください。',
    'en-US': "Part of the app could not be loaded. Quit ASIST and start it again. If that doesn't help, reinstall the app.",
    'fr-FR': "Une partie de l'app n'a pas pu être chargée. Quittez ASIST et relancez-le. Si cela ne suffit pas, réinstallez l'app.",
    'de-DE': 'Ein Teil der App konnte nicht geladen werden. Beenden Sie ASIST und starten Sie es erneut. Hilft das nicht, installieren Sie die App neu.',
    'hi-IN': 'ऐप का एक हिस्सा लोड नहीं हो सका। ASIST बंद करके फिर से शुरू करें। इससे ठीक न हो तो ऐप दोबारा इंस्टॉल करें।',
    'id-ID': 'Sebagian aplikasi tidak bisa dimuat. Tutup ASIST lalu jalankan lagi. Jika tetap begitu, pasang ulang aplikasinya.',
    'it-IT': "Non è stato possibile caricare una parte dell'app. Chiudi ASIST e avvialo di nuovo. Se il problema resta, reinstalla l'app.",
    'ko-KR': '앱의 일부를 불러오지 못했습니다. ASIST를 종료하고 다시 실행하십시오. 그래도 해결되지 않으면 앱을 다시 설치하십시오.',
    'pt-BR': 'Não foi possível carregar parte do app. Encerre o ASIST e abra novamente. Se não resolver, reinstale o app.',
    'es-419': 'No se pudo cargar una parte de la app. Sal de ASIST y vuelve a abrirla. Si el problema sigue, reinstala la app.',
    'es-ES': 'No se ha podido cargar una parte de la app. Sal de ASIST y ábrela de nuevo. Si no se soluciona, vuelve a instalarla.'
  },
  bridgeMissing: {
    'ja-JP': '画面とアプリ本体をつなぐ部品がありません',
    'en-US': 'The part that connects this window to the app is missing',
    'fr-FR': "Le composant qui relie cette fenêtre à l'app est absent",
    'de-DE': 'Der Teil, der dieses Fenster mit der App verbindet, fehlt',
    'hi-IN': 'इस विंडो को ऐप से जोड़ने वाला हिस्सा मौजूद नहीं है',
    'id-ID': 'Komponen yang menghubungkan jendela ini dengan aplikasi tidak ada',
    'it-IT': "Manca il componente che collega questa finestra all'app",
    'ko-KR': '이 창과 앱 본체를 연결하는 부분이 없습니다',
    'pt-BR': 'Falta o componente que liga esta janela ao app',
    'es-419': 'Falta el componente que conecta esta ventana con la app',
    'es-ES': 'Falta el componente que conecta esta ventana con la app'
  },
  bridgeMethodMissing: {
    'ja-JP': '画面とアプリ本体をつなぐ部品に「{method}」がありません',
    'en-US': 'The part that connects this window to the app has no "{method}"',
    'fr-FR': "Le composant qui relie cette fenêtre à l'app n'a pas de « {method} »",
    'de-DE': 'Dem Teil, der dieses Fenster mit der App verbindet, fehlt „{method}“',
    'hi-IN': 'इस विंडो को ऐप से जोड़ने वाले हिस्से में "{method}" नहीं है',
    'id-ID': 'Komponen yang menghubungkan jendela ini dengan aplikasi tidak punya "{method}"',
    'it-IT': "Nel componente che collega questa finestra all'app manca «{method}»",
    'ko-KR': "이 창과 앱 본체를 연결하는 부분에 '{method}' 메서드가 없습니다",
    'pt-BR': 'O componente que liga esta janela ao app não tem “{method}”',
    'es-419': 'Al componente que conecta esta ventana con la app le falta «{method}»',
    'es-ES': 'Al componente que conecta esta ventana con la app le falta “{method}”'
  }
})
