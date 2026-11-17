import type { Lang } from '.';

/**
 * Site strings. The static index.html is in English (that’s what search engines and link
 * previews see); main.ts swaps the texts to the visitor’s language.
 * about1..about5 are the paragraphs of the “Why this exists” section.
 */
export const UI_STRINGS = {
  en: {
    metaTitle: 'please just text me — reply to voice messages with a typing video',
    metaDescription:
      'Got another voice message? Reply just as inconveniently: type your answer and get a video of hands slowly typing it on a phone. Free, nothing to install.',
    heroTitle: 'Another voice message?',
    heroLead: 'Reply just as inconveniently: a video of you typing the answer. Let them sit through it.',
    whyLink: 'Why?',
    textLabel: 'Your reply',
    textPlaceholder: 'Type what you wanted to say…',
    modeLabel: 'Typing style',
    modeNormal: 'Normal',
    modeGrandpa: 'Grandpa, one finger',
    modeTypos: 'With typos',
    modeManicure: 'With a manicure 💅',
    modeBreaks: 'With coffee & smoke breaks ☕',
    grandpaTooLong:
      'Grandpa is getting on a bit — he can’t poke out more than {n} characters with one finger. Shorten the text or pick another style.',
    breaksTooLong:
      'With all these coffee and smoke breaks, more than {n} characters won’t fit into a minute. Shorten the text or pick another style.',
    render: 'Make the video',
    renderingTitle: 'Typing your reply…',
    rendering: 'Keep this tab open, it only takes a moment.',
    videoReady: 'Your video is ready',
    shareHint: 'Pick WhatsApp, Telegram or any messenger',
    download: 'Download',
    downloadHint: 'Then send the file in any messenger',
    makeAnother: 'Make another',
    cancel: 'Cancel',
    close: 'Close',
    share: 'Send',
    failed: 'Could not make the video 😢',
    unsupported: 'This browser can’t encode H.264 video. Please update iOS / Chrome.',
    aboutTitle: 'Why this exists',
    about1:
      'Voice messages are convenient for the person recording them. Not for the one receiving them: you can’t skim them, can’t read them in a meeting, on the subway without headphones or at 3 a.m. next to someone sleeping. So you listen to two minutes of “so, um, listen…” to get one sentence.',
    about2:
      'People have wanted to answer in kind for a long time — some film themselves writing a reply with a pen on paper, others typing it in Word. We made it one tap: write your reply and get a video of hands unhurriedly typing it on a phone. To read it, they’ll have to watch. Exactly like you had to listen.',
    about3: 'It’s a joke, not a war. Send it, laugh together — and maybe the next message will arrive as text.',
    about5:
      'To be clear: voice messages are great when there’s no better way. If you’re driving, find typing or reading the screen hard, or your hands are just busy — record away. The joke is about the habit of sending a two-minute voice note where one line would do, and it’s meant for people who’ll laugh along with you.',
    about4: 'The video is made right on your phone. Your text is never uploaded or stored anywhere. We only count anonymous visits and button taps — no cookies.',
    contactLead:
      'Ideas or found a bug?',
    inappHint:
      'Sending may not work in this app’s built-in browser. Open the page in Safari or Chrome: tap ⋯ → Open in browser.',
    openInChrome:
      'Open in Chrome',
    footer: 'Made on your device · nothing is uploaded',
  },
  ru: {
    metaTitle: 'please just text me — ответь на голосовое видео, где ты печатаешь',
    metaDescription:
      'Опять прислали голосовое? Ответь так же неудобно: напиши текст и получи видео, где руки неспешно печатают его на телефоне. Бесплатно, ничего не нужно устанавливать.',
    heroTitle: 'Опять голосовое?',
    heroLead: 'Ответь так же неудобно: видео, где ты печатаешь ответ. Пусть посмотрит до конца.',
    whyLink: 'Зачем?',
    textLabel: 'Текст ответа',
    textPlaceholder: 'Напиши, что хотел сказать…',
    modeLabel: 'Как печатать',
    modeNormal: 'Обычно',
    modeGrandpa: 'Дед одним пальцем',
    modeTypos: 'С опечатками',
    modeManicure: 'С маникюром 💅',
    modeBreaks: 'С перекурами ☕',
    grandpaTooLong:
      'Дедушка старенький — больше {n} символов одним пальцем не осилит. Сократи текст или выбери другой режим.',
    breaksTooLong:
      'С такими перекурами больше {n} символов в минуту не влезет. Сократи текст или выбери другой режим.',
    render: 'Сделать видео',
    renderingTitle: 'Печатаем ответ…',
    rendering: 'Не сворачивай вкладку — это недолго.',
    videoReady: 'Видео готово',
    shareHint: 'Выбери WhatsApp, Telegram или любой мессенджер',
    download: 'Скачать',
    downloadHint: 'Потом отправь файл в любом мессенджере',
    makeAnother: 'Сделать ещё',
    cancel: 'Отмена',
    close: 'Закрыть',
    share: 'Отправить',
    failed: 'Не получилось сделать видео 😢',
    unsupported: 'Этот браузер не умеет кодировать видео H.264. Обнови iOS / Chrome.',
    aboutTitle: 'Зачем это всё',
    about1:
      'Голосовые удобны тому, кто их записывает. Тому, кто получает, — нет: их не пробежать глазами, не прочитать на совещании, в метро без наушников или в три часа ночи рядом со спящими. Приходится слушать две минуты «ну короче, слушай…» ради одной фразы.',
    about2:
      'Ответить тем же людям хотелось давно — кто-то снимает на видео, как пишет ответ ручкой на бумаге, кто-то — как набирает его в Ворде. Мы сделали это в одно нажатие: пишешь ответ — получаешь видео, где руки неспешно набирают его на телефоне. Чтобы прочитать, придётся смотреть. Ровно как тебе пришлось слушать.',
    about3: 'Это шутка, а не война. Отправь, посмейтесь вместе — и, может быть, следующее сообщение придёт текстом.',
    about5:
      'Важно: голосовые — отличная штука, когда по-другому никак. Если ты за рулём, тебе трудно печатать или видеть экран, или просто заняты руки — записывай и не сомневайся. Шутка не про это, а про привычку присылать двухминутное голосовое там, где хватило бы одной строчки. И она для тех, кто посмеётся вместе с тобой.',
    about4: 'Видео создаётся прямо на твоём телефоне. Текст никуда не отправляется и нигде не хранится. Мы считаем только анонимные заходы и нажатия кнопок — без cookies.',
    contactLead:
      'Есть идеи или нашли баг?',
    inappHint:
      'Во встроенном браузере приложения отправка может не сработать. Открой страницу в Safari или Chrome: нажми ⋯ → «Открыть в браузере».',
    openInChrome:
      'Открыть в Chrome',
    footer: 'Делается на твоём устройстве · ничего не загружается',
  },
  es: {
    metaTitle: 'please just text me — responde a los audios con un video tuyo escribiendo',
    metaDescription:
      '¿Otro audio? Devuélvele la incomodidad: escribe tu respuesta y recibe un video de unas manos tecleándola con calma en el teléfono. Gratis, sin instalar nada.',
    heroTitle: '¿Otro audio?',
    heroLead: 'Devuélvele la misma incomodidad: un video tuyo escribiendo la respuesta. Que lo vea enterito.',
    whyLink: '¿Por qué?',
    textLabel: 'Tu respuesta',
    textPlaceholder: 'Escribe lo que querías decir…',
    modeLabel: 'Cómo escribir',
    modeNormal: 'Normal',
    modeGrandpa: 'Abuelo con un dedo',
    modeTypos: 'Con errores',
    modeManicure: 'Con manicura 💅',
    modeBreaks: 'Con pausas para café y cigarro ☕',
    grandpaTooLong:
      'El abuelo ya no está para estos trotes: con un dedo no pasa de {n} caracteres. Acorta el texto o elige otro estilo.',
    breaksTooLong:
      'Con tantas pausas para café y cigarro, más de {n} caracteres no caben en un minuto. Acorta el texto o elige otro estilo.',
    render: 'Crear video',
    renderingTitle: 'Escribiendo tu respuesta…',
    rendering: 'No cierres esta pestaña, es solo un momento.',
    videoReady: 'Tu video está listo',
    shareHint: 'Elige WhatsApp, Telegram o cualquier app de mensajes',
    download: 'Descargar',
    downloadHint: 'Luego envía el archivo por cualquier app de mensajes',
    makeAnother: 'Crear otro',
    cancel: 'Cancelar',
    close: 'Cerrar',
    share: 'Enviar',
    failed: 'No se pudo crear el video 😢',
    unsupported: 'Este navegador no puede codificar video H.264. Actualiza iOS / Chrome.',
    aboutTitle: 'Por qué existe esto',
    about1:
      'Los audios son cómodos para quien los graba. No para quien los recibe: no se pueden leer por encima, ni en una reunión, ni en el metro sin audífonos, ni a las tres de la mañana al lado de alguien dormido. Así que escuchas dos minutos de “bueno, o sea, mira…” para sacar una frase.',
    about2:
      'Hace tiempo que la gente quiere pagar con la misma moneda: hay quien se graba escribiendo la respuesta a mano en un papel, o tecleándola en Word. Ahora basta con un toque: escribes tu respuesta y recibes un video de unas manos tecleándola sin prisa en el teléfono. Para leerla, tendrá que verlo. Igual que tú tuviste que escuchar.',
    about3: 'Es una broma, no una guerra. Envíalo, ríanse juntos y, quizá, el próximo mensaje llegue por escrito.',
    about5:
      'Que quede claro: los audios son geniales cuando no hay otra forma. Si estás al volante, te cuesta escribir o ver la pantalla, o simplemente tienes las manos ocupadas, grábalos sin dudar. La broma es sobre la costumbre de mandar un audio de dos minutos donde bastaría una línea, y es para quienes se rían contigo.',
    about4: 'El video se crea en tu propio teléfono. Tu texto no se sube ni se guarda en ningún lado. Solo contamos visitas y toques anónimos, sin cookies.',
    contactLead:
      '¿Ideas o encontraste un error?',
    inappHint:
      'Es posible que el envío no funcione en el navegador de esta app. Abre la página en Safari o Chrome: toca ⋯ → Abrir en el navegador.',
    openInChrome:
      'Abrir en Chrome',
    footer: 'Hecho en tu dispositivo · no se sube nada',
  },
  fr: {
    metaTitle:
      'please just text me — réponds aux vocaux par une vidéo où tu tapes',
    metaDescription:
      'Encore un vocal\u202F? Rends-lui la pareille\u00A0: écris ta réponse et reçois une vidéo de mains qui la tapent tranquillement sur un téléphone. Gratuit, rien à installer.',
    heroTitle: 'Encore un vocal\u202F?',
    heroLead:
      'Rends-lui la monnaie de sa pièce\u00A0: une vidéo de toi en train de taper ta réponse. À regarder jusqu’au bout.',
    whyLink: 'Pourquoi\u202F?',
    textLabel: 'Ta réponse',
    textPlaceholder: 'Écris ce que tu voulais dire…',
    modeLabel: 'Style de frappe',
    modeNormal: 'Normal',
    modeGrandpa:
      'Papy, avec un doigt',
    modeTypos:
      'Avec des fautes de frappe',
    modeManicure: 'Avec une manucure 💅',
    modeBreaks: 'Avec pauses café-clope ☕',
    grandpaTooLong:
      'Papy n’est plus tout jeune\u00A0: avec un doigt, il ne peut pas taper plus de {n}\u00A0caractères. Raccourcis le texte ou choisis un autre style.',
    breaksTooLong:
      'Avec toutes ces pauses café-clope, plus de {n}\u00A0caractères ne tiennent pas en une minute. Raccourcis le texte ou choisis un autre style.',
    render: 'Créer la vidéo',
    renderingTitle: 'On tape ta réponse…',
    rendering: 'Garde cet onglet ouvert, ça ne prend qu’un instant.',
    videoReady: 'Ta vidéo est prête',
    shareHint: 'Choisis WhatsApp, Telegram ou n’importe quelle messagerie',
    download: 'Télécharger',
    downloadHint:
      'Puis envoie le fichier sur n’importe quelle messagerie',
    makeAnother: 'En faire une autre',
    cancel: 'Annuler',
    close: 'Fermer',
    share: 'Envoyer',
    failed: 'Impossible de créer la vidéo 😢',
    unsupported:
      'Ce navigateur ne sait pas encoder de vidéo H.264. Mets à jour iOS / Chrome.',
    aboutTitle: 'Pourquoi ce site',
    about1:
      'Les vocaux, c’est pratique pour qui les enregistre. Pas pour qui les reçoit\u00A0: impossible de les parcourir en diagonale ou de les écouter en réunion, dans le métro sans écouteurs ou à 3\u00A0h du matin à côté de quelqu’un qui dort. Alors on écoute deux minutes de «\u202Fbon, euh, écoute…\u202F» pour une seule phrase.',
    about2:
      'Ça fait longtemps qu’on a envie de leur rendre la pareille\u00A0: certains se filment en train d’écrire la réponse au stylo sur une feuille, d’autres en train de la taper dans Word. Ici, ça se fait en un clic\u00A0: tu écris ta réponse et tu reçois une vidéo de mains qui la tapent sans se presser sur un téléphone. Pour la lire, il faudra regarder la vidéo. Exactement comme toi, tu as dû écouter.',
    about3:
      'C’est une blague, pas une guerre. Envoie la vidéo, histoire d’en rire ensemble — et qui sait, le prochain message arrivera peut-être par écrit.',
    about5:
      'Petite précision\u00A0: les vocaux, c’est super quand on ne peut pas faire autrement. Si tu conduis, si tu as du mal à taper ou à lire l’écran, ou si tu as tout simplement les mains prises, envoie des vocaux sans complexe. La blague porte sur l’habitude d’envoyer un vocal de deux minutes là où une ligne aurait suffi, et elle s’adresse à ceux qui en riront avec toi.',
    about4: 'La vidéo est créée directement sur ton téléphone. Ton texte n’est ni envoyé ni stocké nulle part. On compte seulement les visites et les clics anonymes, sans cookies.',
    contactLead:
      'Des idées ou un bug\u202F?',
    inappHint:
      'L’envoi risque de ne pas marcher dans le navigateur intégré de cette appli. Ouvre la page dans Safari ou Chrome\u00A0: touche ⋯ → Ouvrir dans le navigateur.',
    openInChrome:
      'Ouvrir dans Chrome',
    footer:
      'Tout se passe sur ton appareil · rien n’est envoyé',
  },
} satisfies Record<Lang, Record<string, string>>;

export type UiKey = keyof (typeof UI_STRINGS)['en'];
