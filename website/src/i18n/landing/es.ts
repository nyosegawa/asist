import type { LandingText } from './ja'

export const es: LandingText = {
  meta: {
    title: 'ASIST — solo habla, y tu agenda y tu correo quedan resueltos.',
    description: 'ASIST es un asistente en tiempo real para Mac. Solo habla y te ayuda con tu trabajo. El clima, los eventos y el correo aparecen como tarjetas junto a la conversación, y el trabajo que lleva tiempo pasa a un agente.',
    ogDescription: 'Un asistente en tiempo real para Mac. Solo habla y te ayuda con tu trabajo.'
  },
  nav: {
    label: 'En esta página',
    footerLabel: 'Pie de página',
    home: 'Pantalla de inicio',
    cards: 'Tarjetas',
    apps: 'Miniapps',
    agent: 'Agent',
    memory: 'Memoria',
    start: 'Empezar',
    docs: 'Documentación',
    github: 'Ver en GitHub',
    language: 'Idioma'
  },
  hero: {
    titleHtml: 'Solo habla,<br />y tu agenda y tu correo<br />quedan resueltos.',
    leadHtml: 'ASIST es un <span class="nw">asistente en tiempo real para Mac.</span><br />Solo habla y te ayuda con tu trabajo.',
    start: 'Empezar',
    macos: 'macOS 14 o posterior',
    free: 'Gratis y de código abierto',
    silicon: 'Apple Silicon',
    artAlt: 'Un diorama de plastilina: ASIST en un escritorio frente a una Mac, con un robot al lado',
    youHtml: 'Oye, ASIST,<br />¿qué tengo hoy?',
    meHtml: 'Así viene<br />tu día',
    cardAlt: 'Una tarjeta con los eventos de hoy'
  },
  home: {
    title: 'Pantalla de inicio',
    headline: 'La conversación y las tarjetas, en una sola pantalla.',
    body: 'Hablas en el centro y las tarjetas con las respuestas se acomodan a ambos lados. Desde el Dock, abajo, abres las miniapps.',
    shotAlt: 'La pantalla de inicio de ASIST: la conversación en el centro, una tarjeta de tipos de cambio a la izquierda, una tarjeta del clima a la derecha y el Dock abajo',
    card: 'Tarjeta',
    talk: 'Conversación',
    apps: 'Miniapps'
  },
  cards: {
    title: 'Tarjetas',
    headline: 'Lo que necesitas, al instante.',
    body: 'El clima, el calendario, borradores de correo, pendientes, tipos de cambio, noticias, mapas, temporizadores y más aparecen como tarjetas junto a la conversación mientras ASIST te responde en voz alta.',
    label: 'Ejemplos de tarjetas',
    weather: 'Una tarjeta del clima',
    map: 'Una tarjeta con un mapa',
    calendar: 'Una tarjeta de eventos',
    fx: 'Una tarjeta de tipos de cambio',
    mailDraft: 'Una tarjeta con un borrador de correo',
    todo: 'Una tarjeta de pendientes',
    timer: 'Una tarjeta de temporizador',
    note: '“¿Cómo va a estar el clima mañana?”'
  },
  apps: {
    title: 'Miniapps',
    headline: 'Fáciles de usar.',
    body: 'Abre los trabajos del Agent, las tareas, las notas, el correo, la memoria y el calendario directamente desde las miniapps, o desde la conversación: “Abre la próxima semana en el calendario”.',
    agent: 'Agent',
    tasks: 'Tareas',
    notes: 'Notas',
    mail: 'Correo',
    memory: 'Memoria',
    calendar: 'Calendario',
    settings: 'Configuración'
  },
  agent: {
    title: 'Agent',
    headline: 'Delega el trabajo tedioso.',
    body: 'Las investigaciones y las ediciones de archivos que llevan tiempo pasan a la CLI de codex o de claude, una vez que las apruebas.',
    artAlt: 'Un diorama de plastilina: ASIST le entrega unos papeles a un robot',
    askHtml: '¿Me resumes<br />estos papeles?',
    confirm: '¿Empezar este trabajo?',
    confirmMeta: 'Directorio de trabajo ~/work/report · Solo lectura',
    cancel: 'Cancelar',
    startJob: 'Empezar trabajo'
  },
  memory: {
    title: 'Memoria',
    headline: 'Un agente escribe un diario y ordena lo que recuerda.',
    body: 'Cada noche, a medianoche, escribe un diario a partir de las conversaciones del día: sobre ti y sobre su propio día. La conversación del día siguiente parte de lo que recuerda.',
    artAlt: 'Un diorama de plastilina: ASIST dormido de noche, abrazando su diario',
    diaryDate: 'Diario · miércoles 23 de septiembre',
    diaryTitle: 'El día que corregimos juntos el borrador de la propuesta',
    diaryBody: 'A primera hora de la tarde me pidieron que leyera en voz alta el borrador de la propuesta. Noté que la tercera sección decía lo mismo que la anterior, y se lo comenté.',
    noteHtml: 'De verdad<br />se acuerda…'
  },
  start: {
    title: 'Empecemos.',
    sub: 'ASIST, en tu Mac.',
    download: 'Descargar',
    setup: 'Guía de configuración',
    bubble: '¡Vamos!',
    step1: 'Consigue una Mac con Apple Silicon y una clave de API para un modelo de conversación.',
    step2: 'Descarga el dmg, ábrelo y arrastra ASIST a Aplicaciones. Las nuevas versiones llegan solas.',
    step3: 'Elige el idioma, el modelo, la voz y el micrófono en la configuración inicial, y empieza a hablar.'
  },
  footer: {
    analytics: 'Este sitio usa Google Analytics, que instala cookies, para contar las visitas.',
    analyticsLink: 'Cómo usa Google los datos'
  }
}
