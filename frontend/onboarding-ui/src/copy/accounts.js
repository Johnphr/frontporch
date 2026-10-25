// Setup step 6: where his stories are posted (his own Bluesky, Threads and X accounts).
// English and Spanish; error keys are the backend's codes (signup:connectBluesky,
// signup:startOAuthConnect, and the ?connect_error= codes from the OAuth callbacks).
// The page is English for now: accountsCopy(them, name) picks 'en'; pass 'es' for a Spanish page.

const EN = {
  title: (them, n) => (them ? `Where should ${n}'s stories go?` : 'Where should your stories go?'),
  lead: (them) =>
    `Stories are posted on ${them ? 'their' : 'your'} own accounts, under ${them ? 'their' : 'your'} name. This step is optional: you can skip it.`,
  saved: 'Your sign-up is saved.',
  finish: 'Finish',
  finishing: 'Finishing…',
  skip: 'Skip and finish',

  bluesky: {
    title: 'Bluesky',
    lead: 'For Bluesky we need an “app password”. It is not your regular password.',
    howTitle: 'How to get one (about 2 minutes):',
    how: [
      'Open Bluesky and go to Settings → Privacy and security → App passwords.',
      'Tap “Add App Password” and give it a name, for example: Front Porch. Leave direct messages off.',
      'Copy the password it shows and paste it below.',
    ],
    link: 'Open app passwords in Bluesky',
    newTab: '(opens in a new tab)',
    handle: 'Bluesky username',
    handleHint: 'For example: @walter.bsky.social',
    handleInvalid: 'Please check the username. It should look like walter.bsky.social.',
    password: 'App password',
    passwordHint: 'It looks like this: abcd-efgh-ijkl-mnop',
    passwordInvalid: 'That does not look like an app password. It should look like abcd-efgh-ijkl-mnop.',
    show: 'Show password',
    hide: 'Hide password',
    safety:
      'Please do not type the regular Bluesky password here. We only accept app passwords: nobody can use one to change the password or delete the account, and it can be removed in Bluesky at any time.',
    use: 'We only use it to post stories and replies.',
    connect: 'Connect Bluesky',
    connecting: 'Checking with Bluesky…',
    connected: (handle) => `Bluesky connected: @${handle}. Stories will be posted there.`,
    locked: 'Bluesky is already connected and working. Nothing to change.',
    errors: {
      invalid_handle: 'Please check the username. It should look like walter.bsky.social.',
      not_app_password: 'For safety, please use an app password, not the regular password. You can make one with the link above.',
      privileged_app_password:
        'That app password can read private messages, and we do not need that. Please make a new one in Bluesky without direct message access.',
      wrong_password: 'Bluesky did not accept that username and password. Please check the spelling, or make a new app password.',
      account_unavailable: 'Bluesky says that account is suspended or deactivated. Please check it in Bluesky.',
      rate_limited: 'You have tried a few times already. Please wait a few minutes and try again.',
      busy: 'Many people are connecting right now. Please try again in a few minutes.',
      bluesky_busy: 'Bluesky is not answering right now. Please try again in a few minutes.',
      locked: 'Bluesky is already connected and working. Nothing to change.',
      not_found: "We couldn't find your sign-up. Please sign in again.",
      failed: 'Something went wrong on our side. Please try again in a moment.',
    },
  },

  oauth: {
    title: 'Threads and X',
    connect: (name) => `Connect ${name}`,
    opening: (name) => `Opening ${name}…`,
    done: (name) => `${name} connected. Stories will be posted there too.`,
    connected: (name) => `All set! The ${name} account is connected.`,
    note: 'It opens the official page so you can give permission. We never see the password.',
    notes: {
      x: 'Posting on X costs a few cents per post, so it stays off unless the team turns it on.',
    },
    reddit: 'Reddit: coming soon',
    errors: {
      denied: 'No problem: the account was not connected. You can try again whenever you like.',
      invalid_state: 'That link no longer works. Tap the button to try again.',
      state_used: 'That link was already used. Tap the button to try again.',
      state_expired: 'Too much time went by. Tap the button to try again.',
      exchange_failed: 'We could not finish connecting. Please try again in a moment.',
      missing_scope: 'The permission to post is missing. Tap the button again and allow every permission.',
      not_configured: 'This network is not available yet. You can skip it for now.',
      rate_limited: 'You have tried several times. Please wait a few minutes and try again.',
      locked: 'That account is already connected and working. Nothing to change.',
      not_found: "We couldn't find your sign-up. Please sign in again.",
      failed: 'Something went wrong on our side. Please try again in a moment.',
    },
  },

  // His page (Home tab): where his stories go, and reconnecting one that stopped working.
  page: {
    title: 'Where your stories go',
    connected: (name, handle) => (handle ? `${name}: connected as @${handle}.` : `${name}: connected.`),
    invalid: (name) => `${name} stopped working (the permission was removed). Please reconnect it.`,
    none: (name) => `${name}: not connected.`,
    connect: (name) => `Connect ${name}`,
    reconnect: (name) => `Reconnect ${name}`,
    cancel: 'Cancel',
    saved: (name) => `Saved. Stories will be posted on ${name}.`,
  },
}

const ES = {
  title: (them, n) => (them ? `¿Dónde publicamos las historias de ${n}?` : '¿Dónde publicamos sus historias?'),
  lead: () => 'Las historias se publican en sus propias cuentas, con su nombre. Este paso es opcional: puede omitirlo.',
  saved: 'Su registro quedó guardado.',
  finish: 'Terminar',
  finishing: 'Terminando…',
  skip: 'Omitir y terminar',

  bluesky: {
    title: 'Bluesky',
    lead: 'Para Bluesky necesitamos una «contraseña de aplicación». No es su contraseña normal.',
    howTitle: 'Cómo obtenerla (unos 2 minutos):',
    how: [
      'Abra Bluesky y vaya a Configuración → Privacidad y seguridad → Contraseñas de aplicación.',
      'Toque «Agregar contraseña de aplicación» y póngale un nombre, por ejemplo: Front Porch. Deje apagados los mensajes directos.',
      'Copie la contraseña que aparece y péguela aquí abajo.',
    ],
    link: 'Abrir contraseñas de aplicación en Bluesky',
    newTab: '(se abre en otra pestaña)',
    handle: 'Usuario de Bluesky',
    handleHint: 'Por ejemplo: @javier.bsky.social',
    handleInvalid: 'Revise el usuario. Debe verse como javier.bsky.social.',
    password: 'Contraseña de aplicación',
    passwordHint: 'Se ve así: abcd-efgh-ijkl-mnop',
    passwordInvalid: 'Esa no parece una contraseña de aplicación. Debe verse como abcd-efgh-ijkl-mnop.',
    show: 'Mostrar contraseña',
    hide: 'Ocultar contraseña',
    safety:
      'No escriba aquí la contraseña normal de Bluesky. Solo aceptamos contraseñas de aplicación: con ella nadie puede cambiar la contraseña ni borrar la cuenta, y se puede quitar en Bluesky cuando quiera.',
    use: 'Solo la usamos para publicar historias y respuestas.',
    connect: 'Conectar Bluesky',
    connecting: 'Revisando con Bluesky…',
    connected: (handle) => `Bluesky conectado: @${handle}. Ahí se publicarán las historias.`,
    locked: 'Bluesky ya está conectado y funciona. No hay nada que cambiar.',
    errors: {
      invalid_handle: 'Revise el usuario. Debe verse como javier.bsky.social.',
      not_app_password: 'Por seguridad, use una contraseña de aplicación, no la contraseña normal. Puede crear una con el enlace de arriba.',
      privileged_app_password:
        'Esa contraseña de aplicación puede leer los mensajes privados, y no lo necesitamos. Cree una nueva en Bluesky sin acceso a mensajes directos.',
      wrong_password: 'Bluesky no aceptó ese usuario y contraseña. Revise que estén bien escritos, o cree una contraseña de aplicación nueva.',
      account_unavailable: 'Bluesky dice que esa cuenta está suspendida o desactivada. Revísela en Bluesky.',
      rate_limited: 'Ya lo intentó varias veces. Espere unos minutos y vuelva a intentarlo.',
      busy: 'Mucha gente se está conectando ahora mismo. Intente otra vez en unos minutos.',
      bluesky_busy: 'Bluesky no responde en este momento. Intente otra vez en unos minutos.',
      locked: 'Bluesky ya está conectado y funciona. No hay nada que cambiar.',
      not_found: 'No encontramos su registro. Inicie sesión otra vez, por favor.',
      failed: 'Algo salió mal de nuestro lado. Intente otra vez en un momento.',
    },
  },

  oauth: {
    title: 'Threads y X',
    connect: (name) => `Conectar ${name}`,
    opening: (name) => `Abriendo ${name}…`,
    done: (name) => `${name} conectado. Ahí también se publicarán las historias.`,
    connected: (name) => `¡Listo! La cuenta de ${name} quedó conectada.`,
    note: 'Se abre la página oficial para dar permiso. Nunca vemos la contraseña.',
    notes: {
      x: 'Publicar en X cuesta unos centavos por publicación, así que queda apagado hasta que el equipo lo active.',
    },
    reddit: 'Reddit: próximamente',
    errors: {
      denied: 'No pasa nada: no se conectó la cuenta. Puede intentarlo otra vez cuando quiera.',
      invalid_state: 'El enlace ya no sirve. Toque el botón para intentarlo de nuevo.',
      state_used: 'El enlace ya se usó. Toque el botón para intentarlo de nuevo.',
      state_expired: 'Pasó demasiado tiempo. Toque el botón para intentarlo de nuevo.',
      exchange_failed: 'No pudimos terminar la conexión. Intente otra vez en un momento.',
      missing_scope: 'Falta el permiso para publicar. Toque el botón otra vez y acepte todos los permisos.',
      not_configured: 'Esta red todavía no está disponible. Puede omitirla por ahora.',
      rate_limited: 'Ya lo intentó varias veces. Espere unos minutos y vuelva a intentarlo.',
      locked: 'Esa cuenta ya está conectada y funciona. No hay nada que cambiar.',
      not_found: 'No encontramos su registro. Inicie sesión otra vez, por favor.',
      failed: 'Algo salió mal de nuestro lado. Intente otra vez en un momento.',
    },
  },

  page: {
    title: 'Dónde se publican sus historias',
    connected: (name, handle) => (handle ? `${name}: conectado como @${handle}.` : `${name}: conectado.`),
    invalid: (name) => `${name} dejó de funcionar (se quitó el permiso). Vuelva a conectarlo, por favor.`,
    none: (name) => `${name}: sin conectar.`,
    connect: (name) => `Conectar ${name}`,
    reconnect: (name) => `Volver a conectar ${name}`,
    cancel: 'Cancelar',
    saved: (name) => `Listo. Las historias se publicarán en ${name}.`,
  },
}

export const ACCOUNTS = { en: EN, es: ES }

/** The accounts step's words (English page for now). */
export const accountsCopy = (lang = 'en') => ACCOUNTS[lang] || EN
