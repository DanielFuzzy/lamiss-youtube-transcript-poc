// The language of the extension's own interface (appLanguage, see the
// backend's docs/TDR-0003-Language-Preferences.md). Loaded as a plain script
// before shared/lamiss-api.js everywhere: the worker, the popup, the chat, the
// permission page, the offscreen document and the content script.
//
// appLanguage only changes what the extension shows. It is kept apart from the
// two other languages: the tutor's (tutorLanguage, a backend preference) and
// the captions' (the video's spoken language, picked by the content script).
// It lives in extension storage, so it works signed out and on every page at
// once; each page follows chrome.storage.onChanged.

type LamissAppLanguage = 'en' | 'es' | 'fr' | 'de' | 'pt';

// The quick choices of the language picker, in their own language. English
// and the four most spoken languages that both the backend and the extension
// already support (and that are written left to right, like the layout).
const LAMISS_APP_LANGUAGES: ReadonlyArray<{ code: LamissAppLanguage; nativeName: string }> = [
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'pt', nativeName: 'Português' }
];

const LAMISS_APP_LANGUAGE_KEY = 'lamissAppLanguage';

// One entry per message: English, Spanish, French, German, Portuguese. The
// tuple type makes a missing translation a compile error. {name} is replaced
// by params.name.
type LamissMessageTexts = readonly [en: string, es: string, fr: string, de: string, pt: string];

const LAMISS_MESSAGE_INDEX: Record<LamissAppLanguage, number> = { en: 0, es: 1, fr: 2, de: 3, pt: 4 };

const LAMISS_MESSAGES = {
  // --- Shared ----------------------------------------------------------------
  'appLanguage.label': ["App language", "Idioma de la app", "Langue de l'appli", "App-Sprache", "Idioma do app"],
  'common.signInWithGoogle': ["Sign in with Google", "Iniciar sesión con Google", "Se connecter avec Google", "Mit Google anmelden", "Entrar com o Google"],
  'common.signingIn': ["Signing in…", "Iniciando sesión…", "Connexion…", "Anmeldung läuft…", "Entrando…"],
  'common.continueInGoogle': ["Continue in the Google window", "Continúa en la ventana de Google", "Continue dans la fenêtre Google", "Fahre im Google-Fenster fort", "Continue na janela do Google"],
  'common.signInFailed': ["Sign-in failed. Please try again.", "No se pudo iniciar sesión. Inténtalo de nuevo.", "La connexion a échoué. Réessaie.", "Die Anmeldung ist fehlgeschlagen. Bitte versuche es erneut.", "Não foi possível entrar. Tente novamente."],
  'common.signInCancelled': ["Sign-in was cancelled.", "Se canceló el inicio de sesión.", "La connexion a été annulée.", "Die Anmeldung wurde abgebrochen.", "O login foi cancelado."],
  'common.signInPlease': ["Please sign in with Google.", "Inicia sesión con Google.", "Connecte-toi avec Google.", "Bitte melde dich mit Google an.", "Entre com o Google."],
  'common.signInRequired': ["Sign in to use Lamiss.", "Inicia sesión para usar Lamiss.", "Connecte-toi pour utiliser Lamiss.", "Melde dich an, um Lamiss zu nutzen.", "Entre para usar a Lamiss."],
  'common.signInAgain': ["Please sign in again.", "Vuelve a iniciar sesión.", "Reconnecte-toi.", "Bitte melde dich erneut an.", "Entre novamente."],
  'common.unreachable': ["Could not reach Lamiss at {url}. Check your connection and try again.", "No se pudo contactar con Lamiss en {url}. Comprueba tu conexión e inténtalo de nuevo.", "Impossible de joindre Lamiss à {url}. Vérifie ta connexion et réessaie.", "Lamiss unter {url} ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.", "Não foi possível acessar a Lamiss em {url}. Verifique sua conexão e tente novamente."],
  'common.tryAgain': ["Try again", "Reintentar", "Réessayer", "Erneut versuchen", "Tentar novamente"],
  'common.backHome': ["Back to home", "Volver al inicio", "Retour à l'accueil", "Zurück zur Startseite", "Voltar ao início"],
  'common.loading': ["Loading…", "Cargando…", "Chargement…", "Wird geladen…", "Carregando…"],
  'common.notSet': ["Not set", "Sin definir", "Non défini", "Nicht festgelegt", "Não definido"],
  'common.cancel': ["Cancel", "Cancelar", "Annuler", "Abbrechen", "Cancelar"],
  'common.save': ["Save", "Guardar", "Enregistrer", "Speichern", "Salvar"],
  'common.easy': ["Easy", "Fácil", "Facile", "Leicht", "Fácil"],
  'common.medium': ["Medium", "Media", "Moyenne", "Mittel", "Média"],
  'common.hard': ["Hard", "Difícil", "Difficile", "Schwer", "Difícil"],
  'common.fewer': ["Fewer", "Menos", "Moins", "Weniger", "Menos"],
  'common.more': ["More", "Más", "Plus", "Mehr", "Mais"],
  'common.difficulty': ["Difficulty", "Dificultad", "Difficulté", "Schwierigkeit", "Dificuldade"],
  'common.gapApart': ["At least {gap} apart", "Al menos {gap} entre una y otra", "Au moins {gap} d'écart", "Mindestens {gap} Abstand", "Pelo menos {gap} entre elas"],
  'common.lamissQuestions': ["Lamiss's questions", "Preguntas de Lamiss", "Questions de Lamiss", "Fragen von Lamiss", "Perguntas da Lamiss"],
  'common.dailyGoal': ["Daily goal", "Objetivo diario", "Objectif quotidien", "Tagesziel", "Meta diária"],
  'common.micFailed': ["The microphone could not be opened.", "No se pudo abrir el micrófono.", "Impossible d'ouvrir le micro.", "Das Mikrofon konnte nicht geöffnet werden.", "Não foi possível abrir o microfone."],
  'common.openingMic': ["Opening the microphone…", "Abriendo el micrófono…", "Ouverture du micro…", "Mikrofon wird geöffnet…", "Abrindo o microfone…"],
  'common.allowMic': ["Allow microphone", "Permitir micrófono", "Autoriser le micro", "Mikrofon erlauben", "Permitir microfone"],
  'common.minutes': ["{minutes} min", "{minutes} min", "{minutes} min", "{minutes} Min.", "{minutes} min"],
  'common.off': ["Off", "Desactivado", "Désactivé", "Aus", "Desativado"],
  'common.videosLanguage': ["Video's language", "Idioma del vídeo", "Langue de la vidéo", "Sprache des Videos", "Idioma do vídeo"],

  // --- Popup: home -----------------------------------------------------------------
  'home.tagline': ["Your AI language tutor", "Tu tutor de idiomas con IA", "Ton tuteur de langues IA", "Dein KI-Sprachtutor", "Seu tutor de idiomas com IA"],
  'home.intro': ["Open a YouTube video and practice with me while you watch.", "Abre un vídeo de YouTube y practica conmigo mientras lo ves.", "Ouvre une vidéo YouTube et entraîne-toi avec moi pendant que tu regardes.", "Öffne ein YouTube-Video und übe mit mir, während du es ansiehst.", "Abra um vídeo do YouTube e pratique comigo enquanto assiste."],
  'home.signInTitle': ["Sign in to start learning", "Inicia sesión para empezar a aprender", "Connecte-toi pour commencer à apprendre", "Melde dich an, um mit dem Lernen zu beginnen", "Entre para começar a aprender"],
  'home.sessionEnded': ["Your session ended", "Tu sesión ha terminado", "Ta session a pris fin", "Deine Sitzung ist abgelaufen", "Sua sessão terminou"],
  'home.signInDetail': ["Lamiss keeps your settings and progress with your Google account.", "Lamiss guarda tus ajustes y tu progreso con tu cuenta de Google.", "Lamiss conserve tes réglages et ta progression avec ton compte Google.", "Lamiss speichert deine Einstellungen und deinen Fortschritt mit deinem Google-Konto.", "A Lamiss guarda suas configurações e seu progresso na sua conta Google."],
  'home.signInAgainDetail': ["Please sign in again to keep learning with Lamiss.", "Vuelve a iniciar sesión para seguir aprendiendo con Lamiss.", "Reconnecte-toi pour continuer à apprendre avec Lamiss.", "Bitte melde dich erneut an, um weiter mit Lamiss zu lernen.", "Entre novamente para continuar aprendendo com a Lamiss."],
  'home.start': ["Start Learning", "Empezar a aprender", "Commencer", "Lernen starten", "Começar a aprender"],
  'home.openChat': ["Open the chat", "Abrir el chat", "Ouvrir le chat", "Chat öffnen", "Abrir o chat"],
  'home.gettingReady': ["Getting ready…", "Preparando…", "Préparation…", "Wird vorbereitet…", "Preparando…"],
  'home.signInFirst': ["Sign in first", "Inicia sesión primero", "Connecte-toi d'abord", "Melde dich zuerst an", "Entre primeiro"],
  'home.alreadyHere': ["Lamiss is already with you on this video", "Lamiss ya está contigo en este vídeo", "Lamiss est déjà avec toi sur cette vidéo", "Lamiss ist schon bei dir in diesem Video", "A Lamiss já está com você neste vídeo"],
  'home.willJoin': ["Lamiss will join this video", "Lamiss se unirá a este vídeo", "Lamiss va rejoindre cette vidéo", "Lamiss kommt zu diesem Video dazu", "A Lamiss vai acompanhar este vídeo"],
  'home.openVideoFirst': ["Open a YouTube video first", "Abre primero un vídeo de YouTube", "Ouvre d'abord une vidéo YouTube", "Öffne zuerst ein YouTube-Video", "Abra primeiro um vídeo do YouTube"],
  'home.checkingTab': ["Checking this tab…", "Comprobando esta pestaña…", "Vérification de cet onglet…", "Dieser Tab wird geprüft…", "Verificando esta aba…"],
  'home.settings': ["Settings", "Ajustes", "Réglages", "Einstellungen", "Configurações"],
  'home.captionsTitle': ["Double Captions", "Subtítulos dobles", "Double sous-titrage", "Doppelte Untertitel", "Legendas duplas"],
  'home.captionsDetail': ["Original + translated subtitles", "Subtítulos originales + traducidos", "Sous-titres originaux + traduits", "Original- + übersetzte Untertitel", "Legendas originais + traduzidas"],
  'home.audioTitle': ["Audio & Voice", "Audio y voz", "Audio et voix", "Audio & Stimme", "Áudio e voz"],
  'home.audioDetail': ["Microphone, speaker, tutor voice", "Micrófono, altavoz, voz del tutor", "Micro, haut-parleur, voix du tuteur", "Mikrofon, Lautsprecher, Tutorstimme", "Microfone, alto-falante, voz do tutor"],
  'home.tutorTitle': ["Tutor Behavior", "Comportamiento del tutor", "Comportement du tuteur", "Verhalten des Tutors", "Comportamento do tutor"],
  'home.tutorDetail': ["Kindness, questions, and more", "Amabilidad, preguntas y más", "Bienveillance, questions et plus", "Freundlichkeit, Fragen und mehr", "Gentileza, perguntas e mais"],
  'home.profileTitle': ["Profile & Account", "Perfil y cuenta", "Profil et compte", "Profil & Konto", "Perfil e conta"],
  'home.profileDetail': ["Your preferences and sign out", "Tus preferencias y cerrar sesión", "Tes préférences et la déconnexion", "Deine Einstellungen und Abmelden", "Suas preferências e sair"],
  'home.signInToChange': ["Sign in to change this", "Inicia sesión para cambiarlo", "Connecte-toi pour modifier ceci", "Melde dich an, um das zu ändern", "Entre para alterar isto"],
  'home.checking': ["Checking Lamiss…", "Comprobando Lamiss…", "Vérification de Lamiss…", "Lamiss wird geprüft…", "Verificando a Lamiss…"],
  'home.statusIdle': ["Ready on this video (YouTube)", "Listo en este vídeo (YouTube)", "Prêt sur cette vidéo (YouTube)", "Bereit für dieses Video (YouTube)", "Pronto neste vídeo (YouTube)"],
  'home.statusReady': ["Lamiss is learning with you on this video", "Lamiss está aprendiendo contigo en este vídeo", "Lamiss apprend avec toi sur cette vidéo", "Lamiss lernt mit dir in diesem Video", "A Lamiss está aprendendo com você neste vídeo"],
  'home.statusLoading': ["Getting Lamiss ready on this video…", "Preparando Lamiss en este vídeo…", "Préparation de Lamiss sur cette vidéo…", "Lamiss wird für dieses Video vorbereitet…", "Preparando a Lamiss neste vídeo…"],
  'home.statusError': ["Lamiss had a problem on this video. Try Start Learning again.", "Lamiss tuvo un problema en este vídeo. Prueba de nuevo con Empezar a aprender.", "Lamiss a rencontré un problème sur cette vidéo. Réessaie avec Commencer.", "Lamiss hatte ein Problem mit diesem Video. Versuche es noch einmal mit „Lernen starten“.", "A Lamiss teve um problema neste vídeo. Tente Começar a aprender de novo."],
  'home.statusSessionEnded': ["Your session ended. Sign in again to continue.", "Tu sesión ha terminado. Vuelve a iniciar sesión para continuar.", "Ta session a pris fin. Reconnecte-toi pour continuer.", "Deine Sitzung ist abgelaufen. Melde dich erneut an, um weiterzumachen.", "Sua sessão terminou. Entre novamente para continuar."],
  'home.statusCantReach': ["Lamiss can't be reached right now", "No se puede contactar con Lamiss ahora mismo", "Lamiss est injoignable pour le moment", "Lamiss ist gerade nicht erreichbar", "Não é possível acessar a Lamiss agora"],
  'home.statusUnavailable': ["Lamiss isn't available: {error}", "Lamiss no está disponible: {error}", "Lamiss n'est pas disponible : {error}", "Lamiss ist nicht verfügbar: {error}", "A Lamiss não está disponível: {error}"],
  'home.startUnreachable': ["Lamiss isn't reachable right now", "Lamiss no responde ahora mismo", "Lamiss ne répond pas pour le moment", "Lamiss antwortet gerade nicht", "A Lamiss não está respondendo agora"],
  'home.statusOpenVideo': ["Open a YouTube video to start learning", "Abre un vídeo de YouTube para empezar a aprender", "Ouvre une vidéo YouTube pour commencer à apprendre", "Öffne ein YouTube-Video, um mit dem Lernen zu beginnen", "Abra um vídeo do YouTube para começar a aprender"],
  'home.statusReloadTab': ["Reload the YouTube tab to use Lamiss there", "Recarga la pestaña de YouTube para usar Lamiss allí", "Recharge l'onglet YouTube pour y utiliser Lamiss", "Lade den YouTube-Tab neu, um Lamiss dort zu nutzen", "Recarregue a aba do YouTube para usar a Lamiss nela"],
  'home.startReloadTab': ["Reload the YouTube tab first", "Recarga primero la pestaña de YouTube", "Recharge d'abord l'onglet YouTube", "Lade zuerst den YouTube-Tab neu", "Recarregue a aba do YouTube primeiro"],
  'home.statusOpeningChat': ["Opening the chat…", "Abriendo el chat…", "Ouverture du chat…", "Chat wird geöffnet…", "Abrindo o chat…"],
  'home.statusJoining': ["Lamiss is joining this video…", "Lamiss se está uniendo a este vídeo…", "Lamiss rejoint cette vidéo…", "Lamiss kommt zu diesem Video…", "A Lamiss está entrando neste vídeo…"],

  // --- Popup: double captions --------------------------------------------------------
  'captions.comingSoon': ["Coming soon", "Próximamente", "Bientôt disponible", "Demnächst", "Em breve"],
  'captions.intro': ["Original and translated subtitles, together while you watch.", "Subtítulos originales y traducidos, juntos mientras ves el vídeo.", "Sous-titres originaux et traduits, ensemble pendant que tu regardes.", "Original- und übersetzte Untertitel zusammen, während du schaust.", "Legendas originais e traduzidas, juntas enquanto você assiste."],
  'captions.whatsComing': ["What's coming", "Lo que viene", "Ce qui arrive", "Was kommt", "O que vem por aí"],
  'captions.coming1': ["Lamiss will show the video's own subtitle line with its translation right below it, stacked on the YouTube player, in the language you choose.", "Lamiss mostrará la línea de subtítulos del vídeo con su traducción justo debajo, sobre el reproductor de YouTube, en el idioma que elijas.", "Lamiss affichera la ligne de sous-titres de la vidéo avec sa traduction juste en dessous, sur le lecteur YouTube, dans la langue de ton choix.", "Lamiss zeigt die Untertitelzeile des Videos mit ihrer Übersetzung direkt darunter auf dem YouTube-Player an, in der Sprache deiner Wahl.", "A Lamiss vai mostrar a linha de legenda do vídeo com a tradução logo abaixo, sobre o player do YouTube, no idioma que você escolher."],
  'captions.coming2': ["This isn't available yet, so there's nothing to switch on here today. Lamiss already reads the video's captions to ask you questions about it.", "Todavía no está disponible, así que hoy no hay nada que activar aquí. Lamiss ya lee los subtítulos del vídeo para hacerte preguntas sobre él.", "Ce n'est pas encore disponible, il n'y a donc rien à activer ici pour l'instant. Lamiss lit déjà les sous-titres de la vidéo pour te poser des questions dessus.", "Das ist noch nicht verfügbar, daher gibt es hier heute nichts einzuschalten. Lamiss liest schon die Untertitel des Videos, um dir Fragen dazu zu stellen.", "Isso ainda não está disponível, então não há nada para ativar aqui hoje. A Lamiss já lê as legendas do vídeo para fazer perguntas sobre ele."],

  // --- Popup: audio & voice --------------------------------------------------------------
  'audio.intro': ["Choose your devices and your tutor's voice.", "Elige tus dispositivos y la voz de tu tutor.", "Choisis tes appareils et la voix de ton tuteur.", "Wähle deine Geräte und die Stimme deines Tutors.", "Escolha seus dispositivos e a voz do seu tutor."],
  'audio.microphone': ["Microphone", "Micrófono", "Microphone", "Mikrofon", "Microfone"],
  'audio.systemDefault': ["System default", "Predeterminado del sistema", "Par défaut du système", "Systemstandard", "Padrão do sistema"],
  'audio.micPermission': ["Allow microphone access so Lamiss can list your microphones and hear your answers.", "Permite el acceso al micrófono para que Lamiss pueda mostrar tus micrófonos y oír tus respuestas.", "Autorise l'accès au micro pour que Lamiss puisse lister tes micros et entendre tes réponses.", "Erlaube den Mikrofonzugriff, damit Lamiss deine Mikrofone auflisten und deine Antworten hören kann.", "Permita o acesso ao microfone para que a Lamiss possa listar seus microfones e ouvir suas respostas."],
  'audio.testMic': ["Test microphone", "Probar micrófono", "Tester le micro", "Mikrofon testen", "Testar microfone"],
  'audio.stopTest': ["Stop test", "Detener prueba", "Arrêter le test", "Test beenden", "Parar teste"],
  'audio.speaker': ["Speaker / Output", "Altavoz / Salida", "Haut-parleur / Sortie", "Lautsprecher / Ausgabe", "Alto-falante / Saída"],
  'audio.speakerUnsupported': ["This browser can't pick a speaker for extensions, so Lamiss plays on your default one.", "Este navegador no permite a las extensiones elegir altavoz, así que Lamiss usa el predeterminado.", "Ce navigateur ne permet pas aux extensions de choisir un haut-parleur, Lamiss utilise donc celui par défaut.", "Dieser Browser lässt Erweiterungen keinen Lautsprecher wählen, daher nutzt Lamiss den Standardlautsprecher.", "Este navegador não deixa extensões escolherem o alto-falante, então a Lamiss usa o padrão."],
  'audio.testAudio': ["Test audio", "Probar audio", "Tester le son", "Audio testen", "Testar áudio"],
  'audio.tutorVoice': ["Tutor voice", "Voz del tutor", "Voix du tuteur", "Tutorstimme", "Voz do tutor"],
  'audio.voiceSignIn': ["Sign in to choose Lamiss's voice and speed.", "Inicia sesión para elegir la voz y la velocidad de Lamiss.", "Connecte-toi pour choisir la voix et la vitesse de Lamiss.", "Melde dich an, um Stimme und Tempo von Lamiss zu wählen.", "Entre para escolher a voz e a velocidade da Lamiss."],
  'audio.loadingVoices': ["Loading voices…", "Cargando voces…", "Chargement des voix…", "Stimmen werden geladen…", "Carregando vozes…"],
  'audio.previewVoice': ["Preview voice", "Escuchar voz", "Écouter la voix", "Stimme anhören", "Ouvir voz"],
  'audio.speed': ["Speaking speed", "Velocidad de habla", "Vitesse de parole", "Sprechtempo", "Velocidade da fala"],
  'audio.volume': ["Voice volume", "Volumen de la voz", "Volume de la voix", "Lautstärke der Stimme", "Volume da voz"],
  'audio.noDeviceList': ["This browser doesn't let Lamiss list your devices; it uses the default ones.", "Este navegador no deja que Lamiss muestre tus dispositivos; usa los predeterminados.", "Ce navigateur ne permet pas à Lamiss de lister tes appareils ; il utilise ceux par défaut.", "Dieser Browser lässt Lamiss deine Geräte nicht auflisten; es werden die Standardgeräte verwendet.", "Este navegador não deixa a Lamiss listar seus dispositivos; ela usa os padrões."],
  'audio.micName': ["Microphone {number}", "Micrófono {number}", "Microphone {number}", "Mikrofon {number}", "Microfone {number}"],
  'audio.speakerName': ["Speaker {number}", "Altavoz {number}", "Haut-parleur {number}", "Lautsprecher {number}", "Alto-falante {number}"],
  'audio.micChosen': ["Lamiss will listen with this microphone.", "Lamiss escuchará con este micrófono.", "Lamiss écoutera avec ce micro.", "Lamiss hört mit diesem Mikrofon zu.", "A Lamiss vai ouvir com este microfone."],
  'audio.speakerChosen': ["Lamiss will speak on this speaker.", "Lamiss hablará por este altavoz.", "Lamiss parlera sur ce haut-parleur.", "Lamiss spricht über diesen Lautsprecher.", "A Lamiss vai falar por este alto-falante."],
  'audio.micNotAllowed': ["Lamiss isn't allowed to use the microphone yet. Click \"Allow microphone\" above.", "Lamiss aún no tiene permiso para usar el micrófono. Pulsa «Permitir micrófono» arriba.", "Lamiss n'a pas encore accès au micro. Clique sur « Autoriser le micro » ci-dessus.", "Lamiss darf das Mikrofon noch nicht verwenden. Klicke oben auf „Mikrofon erlauben“.", "A Lamiss ainda não tem permissão para usar o microfone. Clique em \"Permitir microfone\" acima."],
  'audio.noMic': ["No microphone was found. Plug one in and try again.", "No se encontró ningún micrófono. Conecta uno e inténtalo de nuevo.", "Aucun micro n'a été trouvé. Branches-en un et réessaie.", "Es wurde kein Mikrofon gefunden. Schließe eins an und versuche es erneut.", "Nenhum microfone foi encontrado. Conecte um e tente novamente."],
  'audio.micBusy': ["The microphone is busy in another app. Close it there and try again.", "El micrófono está en uso en otra aplicación. Ciérralo allí e inténtalo de nuevo.", "Le micro est utilisé par une autre application. Ferme-la et réessaie.", "Das Mikrofon wird von einer anderen App verwendet. Schließe es dort und versuche es erneut.", "O microfone está em uso em outro app. Feche-o lá e tente novamente."],
  'audio.saySomething': ["Say something: the bars should move.", "Di algo: las barras deberían moverse.", "Dis quelque chose : les barres devraient bouger.", "Sag etwas: Die Balken sollten sich bewegen.", "Diga algo: as barras devem se mexer."],
  'audio.canHear': ["Lamiss can hear you.", "Lamiss te oye.", "Lamiss t'entend.", "Lamiss kann dich hören.", "A Lamiss consegue ouvir você."],
  'audio.cantHear': ["Lamiss can't hear anything. Is the right microphone selected and unmuted?", "Lamiss no oye nada. ¿Está seleccionado el micrófono correcto y sin silenciar?", "Lamiss n'entend rien. Le bon micro est-il sélectionné et non coupé ?", "Lamiss hört nichts. Ist das richtige Mikrofon ausgewählt und nicht stummgeschaltet?", "A Lamiss não está ouvindo nada. O microfone certo está selecionado e com som?"],
  'audio.playingTest': ["Playing a test sound. Didn't hear it? Try another speaker or turn the volume up.", "Reproduciendo un sonido de prueba. ¿No lo oyes? Prueba otro altavoz o sube el volumen.", "Lecture d'un son de test. Tu ne l'entends pas ? Essaie un autre haut-parleur ou monte le volume.", "Ein Testton wird abgespielt. Nichts gehört? Versuche einen anderen Lautsprecher oder dreh die Lautstärke auf.", "Tocando um som de teste. Não ouviu? Tente outro alto-falante ou aumente o volume."],
  'audio.testFailed': ["The test sound could not be played.", "No se pudo reproducir el sonido de prueba.", "Impossible de lire le son de test.", "Der Testton konnte nicht abgespielt werden.", "Não foi possível tocar o som de teste."],
  'audio.oneVoice': ["Your Lamiss server uses this one voice for every language, at its own speed.", "Tu servidor de Lamiss usa esta única voz para todos los idiomas, a su propia velocidad.", "Ton serveur Lamiss utilise cette seule voix pour toutes les langues, à sa propre vitesse.", "Dein Lamiss-Server nutzt diese eine Stimme für alle Sprachen, in ihrem eigenen Tempo.", "Seu servidor Lamiss usa esta única voz para todos os idiomas, na velocidade dela."],
  'audio.providerVoice': ["The {provider} voice", "La voz de {provider}", "La voix {provider}", "Die {provider}-Stimme", "A voz {provider}"],
  'audio.defaultVoiceNamed': ["Default voice ({name})", "Voz predeterminada ({name})", "Voix par défaut ({name})", "Standardstimme ({name})", "Voz padrão ({name})"],
  'audio.defaultVoiceEach': ["Default voice for each language", "Voz predeterminada para cada idioma", "Voix par défaut pour chaque langue", "Standardstimme für jede Sprache", "Voz padrão para cada idioma"],
  'audio.voicesFor': ["Voices for {language}, the language you're learning.", "Voces en {language}, el idioma que estás aprendiendo.", "Voix en {language}, la langue que tu apprends.", "Stimmen für {language}, die Sprache, die du lernst.", "Vozes em {language}, o idioma que você está aprendendo."],
  'audio.noVoicesFor': ["There are no other voices for {language} yet.", "Todavía no hay otras voces en {language}.", "Il n'y a pas encore d'autres voix en {language}.", "Für {language} gibt es noch keine anderen Stimmen.", "Ainda não há outras vozes em {language}."],
  'audio.setLearningLanguage': ["Set the language you're learning in Profile & Account to see just its voices.", "Elige el idioma que estás aprendiendo en Perfil y cuenta para ver solo sus voces.", "Indique la langue que tu apprends dans Profil et compte pour ne voir que ses voix.", "Lege in „Profil & Konto“ die Sprache fest, die du lernst, um nur ihre Stimmen zu sehen.", "Defina o idioma que você está aprendendo em Perfil e conta para ver só as vozes dele."],
  'audio.voicesUnavailable': ["Voices unavailable", "Voces no disponibles", "Voix indisponibles", "Stimmen nicht verfügbar", "Vozes indisponíveis"],
  'audio.gettingReadyToSpeak': ["Lamiss is getting ready to speak…", "Lamiss se prepara para hablar…", "Lamiss se prépare à parler…", "Lamiss macht sich bereit zu sprechen…", "A Lamiss está se preparando para falar…"],
  'audio.couldNotSaveVoice': ["Could not save the voice.", "No se pudo guardar la voz.", "Impossible d'enregistrer la voix.", "Die Stimme konnte nicht gespeichert werden.", "Não foi possível salvar a voz."],
  'audio.playingPreview': ["Playing a preview of this voice.", "Reproduciendo una muestra de esta voz.", "Lecture d'un aperçu de cette voix.", "Eine Hörprobe dieser Stimme wird abgespielt.", "Tocando uma prévia desta voz."],
  'audio.noPreviewFor': ["There's no {language} preview yet, so this one is in English.", "Todavía no hay una muestra en {language}, así que esta es en inglés.", "Il n'y a pas encore d'aperçu en {language}, celui-ci est donc en anglais.", "Es gibt noch keine Hörprobe auf {language}, daher ist diese auf Englisch.", "Ainda não há prévia em {language}, então esta é em inglês."],
  'audio.previewFailed': ["The preview could not be played.", "No se pudo reproducir la muestra.", "Impossible de lire l'aperçu.", "Die Hörprobe konnte nicht abgespielt werden.", "Não foi possível tocar a prévia."],

  // --- Popup: tutor behavior -------------------------------------------------------------
  'tutor.intro': ["Customize how Lamiss talks with you while you learn.", "Personaliza cómo habla Lamiss contigo mientras aprendes.", "Personnalise la façon dont Lamiss te parle pendant que tu apprends.", "Lege fest, wie Lamiss beim Lernen mit dir spricht.", "Personalize como a Lamiss conversa com você enquanto aprende."],
  'tutor.loading': ["Loading your preferences…", "Cargando tus preferencias…", "Chargement de tes préférences…", "Deine Einstellungen werden geladen…", "Carregando suas preferências…"],
  'tutor.kindness': ["Kindness", "Amabilidad", "Bienveillance", "Freundlichkeit", "Gentileza"],
  'tutor.gentle': ["Gentle", "Suave", "Doux", "Sanft", "Gentil"],
  'tutor.balanced': ["Balanced", "Equilibrado", "Équilibré", "Ausgewogen", "Equilibrado"],
  'tutor.strict': ["Strict", "Estricto", "Strict", "Streng", "Rigoroso"],
  'tutor.frequency': ["Question frequency", "Frecuencia de preguntas", "Fréquence des questions", "Fragehäufigkeit", "Frequência de perguntas"],
  'tutor.less': ["Less", "Menos", "Moins", "Weniger", "Menos"],
  'tutor.normal': ["Normal", "Normal", "Normal", "Normal", "Normal"],
  'tutor.more': ["More", "Más", "Plus", "Mehr", "Mais"],
  'tutor.responseLength': ["Response length", "Longitud de las respuestas", "Longueur des réponses", "Antwortlänge", "Tamanho das respostas"],
  'tutor.short': ["Short", "Corta", "Courte", "Kurz", "Curta"],
  'tutor.detailed': ["Detailed", "Detallada", "Détaillée", "Ausführlich", "Detalhada"],
  'tutor.encouragement': ["Encouragement", "Ánimo", "Encouragements", "Ermutigung", "Incentivo"],
  'tutor.encouragementHint': ["Motivational messages and praise", "Mensajes de motivación y elogios", "Messages de motivation et compliments", "Motivierende Nachrichten und Lob", "Mensagens de motivação e elogios"],
  'tutor.language': ["Tutor language", "Idioma del tutor", "Langue du tuteur", "Sprache des Tutors", "Idioma do tutor"],
  'tutor.languageHint': ["Lamiss asks, explains and gives feedback in this language, whatever language the video's captions are in.", "Lamiss pregunta, explica y te corrige en este idioma, sea cual sea el idioma de los subtítulos del vídeo.", "Lamiss pose ses questions, explique et corrige dans cette langue, quelle que soit la langue des sous-titres de la vidéo.", "Lamiss fragt, erklärt und gibt Feedback in dieser Sprache, egal in welcher Sprache die Untertitel des Videos sind.", "A Lamiss pergunta, explica e dá feedback neste idioma, seja qual for o idioma das legendas do vídeo."],
  'tutor.autoPause': ["Auto-pause for questions", "Pausa automática en las preguntas", "Pause automatique pour les questions", "Automatische Pause bei Fragen", "Pausa automática nas perguntas"],
  'tutor.autoPauseOn': ["Lamiss will pause the video when asking you", "Lamiss pausará el vídeo cuando te pregunte", "Lamiss mettra la vidéo en pause pour te poser une question", "Lamiss pausiert das Video, wenn sie dich etwas fragt", "A Lamiss vai pausar o vídeo quando perguntar algo"],
  'tutor.autoPauseOff': ["The video keeps playing, quieter, while Lamiss asks you", "El vídeo sigue sonando, más bajo, mientras Lamiss te pregunta", "La vidéo continue, moins fort, pendant que Lamiss te pose une question", "Das Video läuft leiser weiter, während Lamiss dich etwas fragt", "O vídeo continua tocando, mais baixo, enquanto a Lamiss pergunta"],
  'tutor.footnote': ["Kindness, length and encouragement shape Lamiss's answers to your questions and its feedback on your answers.", "La amabilidad, la longitud y el ánimo dan forma a las respuestas de Lamiss a tus preguntas y a sus comentarios sobre tus respuestas.", "La bienveillance, la longueur et les encouragements façonnent les réponses de Lamiss à tes questions et ses retours sur tes réponses.", "Freundlichkeit, Länge und Ermutigung prägen die Antworten von Lamiss auf deine Fragen und ihr Feedback zu deinen Antworten.", "Gentileza, tamanho e incentivo moldam as respostas da Lamiss às suas perguntas e o feedback dela sobre as suas respostas."],

  // --- Popup: saving ---------------------------------------------------------------------
  'save.saving': ["Saving…", "Guardando…", "Enregistrement…", "Wird gespeichert…", "Salvando…"],
  'save.saved': ["Saved", "Guardado", "Enregistré", "Gespeichert", "Salvo"],
  'save.notSaved': ["Not saved", "No guardado", "Non enregistré", "Nicht gespeichert", "Não salvo"],
  'save.notSavedBecause': ["Not saved: {reason}", "No guardado: {reason}", "Non enregistré : {reason}", "Nicht gespeichert: {reason}", "Não salvo: {reason}"],
  'save.pleaseTryAgain': ["please try again.", "inténtalo de nuevo.", "réessaie.", "bitte versuche es erneut.", "tente novamente."],
  'popup.unreachable': ["Lamiss can't be reached right now. Check your connection and try again.", "No se puede contactar con Lamiss ahora mismo. Comprueba tu conexión e inténtalo de nuevo.", "Lamiss est injoignable pour le moment. Vérifie ta connexion et réessaie.", "Lamiss ist gerade nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.", "Não é possível acessar a Lamiss agora. Verifique sua conexão e tente novamente."],

  // --- Popup: profile & account ------------------------------------------------------------
  'profile.intro': ["Your account and learning preferences.", "Tu cuenta y tus preferencias de aprendizaje.", "Ton compte et tes préférences d'apprentissage.", "Dein Konto und deine Lerneinstellungen.", "Sua conta e suas preferências de aprendizado."],
  'profile.username': ["Username", "Nombre de usuario", "Nom d'utilisateur", "Benutzername", "Nome de usuário"],
  'profile.usernameHint': ["3–20 letters, numbers or underscores. Your name and picture come from Google.", "De 3 a 20 letras, números o guiones bajos. Tu nombre y tu foto vienen de Google.", "3 à 20 lettres, chiffres ou tirets bas. Ton nom et ta photo viennent de Google.", "3–20 Buchstaben, Ziffern oder Unterstriche. Dein Name und dein Bild kommen von Google.", "De 3 a 20 letras, números ou sublinhados. Seu nome e sua foto vêm do Google."],
  'profile.learningPreferences': ["Learning preferences", "Preferencias de aprendizaje", "Préférences d'apprentissage", "Lerneinstellungen", "Preferências de aprendizado"],
  'profile.native': ["Native language", "Idioma nativo", "Langue maternelle", "Muttersprache", "Idioma nativo"],
  'profile.learning': ["Learning language", "Idioma que aprendes", "Langue apprise", "Lernsprache", "Idioma que você aprende"],
  'profile.level': ["Proficiency level", "Nivel", "Niveau", "Sprachniveau", "Nível"],
  'profile.goal': ["Learning goal", "Objetivo de aprendizaje", "Objectif d'apprentissage", "Lernziel", "Objetivo de aprendizado"],
  'profile.optional': ["(optional)", "(opcional)", "(facultatif)", "(optional)", "(opcional)"],
  'profile.dailyGoalHint': ["Minutes of video you watch with Lamiss each day. Slide to the left for no goal.", "Minutos de vídeo que ves con Lamiss cada día. Desliza a la izquierda para no tener objetivo.", "Minutes de vidéo regardées avec Lamiss chaque jour. Glisse à gauche pour ne pas avoir d'objectif.", "Minuten Video, die du jeden Tag mit Lamiss schaust. Schiebe nach links für kein Ziel.", "Minutos de vídeo que você assiste com a Lamiss por dia. Deslize para a esquerda para não ter meta."],
  'profile.practice': ["Practice", "Práctica", "Pratique", "Übung", "Prática"],
  'profile.logOut': ["Log Out", "Cerrar sesión", "Se déconnecter", "Abmelden", "Sair"],
  'profile.loggingOut': ["Logging out…", "Cerrando sesión…", "Déconnexion…", "Abmeldung läuft…", "Saindo…"],
  'profile.levelA1': ["A1 · Beginner", "A1 · Principiante", "A1 · Débutant", "A1 · Anfänger", "A1 · Iniciante"],
  'profile.levelA2': ["A2 · Elementary", "A2 · Elemental", "A2 · Élémentaire", "A2 · Grundlegend", "A2 · Básico"],
  'profile.levelB1': ["B1 · Intermediate", "B1 · Intermedio", "B1 · Intermédiaire", "B1 · Mittelstufe", "B1 · Intermediário"],
  'profile.levelB2': ["B2 · Upper intermediate", "B2 · Intermedio alto", "B2 · Intermédiaire avancé", "B2 · Gute Mittelstufe", "B2 · Intermediário superior"],
  'profile.levelC1': ["C1 · Advanced", "C1 · Avanzado", "C1 · Avancé", "C1 · Fortgeschritten", "C1 · Avançado"],
  'profile.levelC2': ["C2 · Proficient", "C2 · Maestría", "C2 · Maîtrise", "C2 · Kompetent", "C2 · Proficiente"],
  'goal.CONVERSATION': ["Conversation", "Conversación", "Conversation", "Konversation", "Conversação"],
  'goal.VOCABULARY': ["Vocabulary", "Vocabulario", "Vocabulaire", "Wortschatz", "Vocabulário"],
  'goal.GRAMMAR': ["Grammar", "Gramática", "Grammaire", "Grammatik", "Gramática"],
  'goal.LISTENING': ["Listening", "Comprensión auditiva", "Compréhension orale", "Hörverstehen", "Compreensão auditiva"],
  'goal.PRONUNCIATION': ["Pronunciation", "Pronunciación", "Prononciation", "Aussprache", "Pronúncia"],
  'practice.progress': ["{practiced} of {goal} min today", "{practiced} de {goal} min hoy", "{practiced} sur {goal} min aujourd'hui", "{practiced} von {goal} Min. heute", "{practiced} de {goal} min hoje"],
  'practice.reached': ["Daily goal reached", "Objetivo diario cumplido", "Objectif quotidien atteint", "Tagesziel erreicht", "Meta diária alcançada"],
  'username.rules': ["Use 3–20 letters, numbers or underscores.", "Usa de 3 a 20 letras, números o guiones bajos.", "Utilise 3 à 20 lettres, chiffres ou tirets bas.", "Verwende 3–20 Buchstaben, Ziffern oder Unterstriche.", "Use de 3 a 20 letras, números ou sublinhados."],
  'username.taken': ["That username is already taken. Try another one.", "Ese nombre de usuario ya está en uso. Prueba con otro.", "Ce nom d'utilisateur est déjà pris. Essaies-en un autre.", "Dieser Benutzername ist schon vergeben. Versuche einen anderen.", "Esse nome de usuário já está em uso. Tente outro."],

  // --- Chat panel ------------------------------------------------------------------------
  'chat.starting': ["Starting your session…", "Iniciando tu sesión…", "Démarrage de ta session…", "Deine Sitzung wird gestartet…", "Iniciando sua sessão…"],
  'chat.questionSettings': ["Question settings", "Ajustes de preguntas", "Réglages des questions", "Frageeinstellungen", "Configurações de perguntas"],
  'chat.hide': ["Hide the Lamiss chat", "Ocultar el chat de Lamiss", "Masquer le chat Lamiss", "Lamiss-Chat ausblenden", "Ocultar o chat da Lamiss"],
  'chat.howMany': ["How many", "Cuántas", "Combien", "Wie viele", "Quantas"],
  'chat.settingsHint': ["Lamiss only asks about parts of the video you've already watched. Changes apply right away.", "Lamiss solo pregunta sobre partes del vídeo que ya has visto. Los cambios se aplican al instante.", "Lamiss ne pose des questions que sur les parties de la vidéo que tu as déjà vues. Les changements s'appliquent tout de suite.", "Lamiss fragt nur nach Teilen des Videos, die du schon gesehen hast. Änderungen gelten sofort.", "A Lamiss só pergunta sobre partes do vídeo que você já assistiu. As mudanças valem na hora."],
  'chat.conversation': ["Conversation with Lamiss", "Conversación con Lamiss", "Conversation avec Lamiss", "Unterhaltung mit Lamiss", "Conversa com a Lamiss"],
  'chat.signInTitle': ["Sign in to use Lamiss", "Inicia sesión para usar Lamiss", "Connecte-toi pour utiliser Lamiss", "Melde dich an, um Lamiss zu nutzen", "Entre para usar a Lamiss"],
  'chat.signInDetail': ["Your conversations are saved to your Lamiss account.", "Tus conversaciones se guardan en tu cuenta de Lamiss.", "Tes conversations sont enregistrées dans ton compte Lamiss.", "Deine Unterhaltungen werden in deinem Lamiss-Konto gespeichert.", "Suas conversas ficam salvas na sua conta Lamiss."],
  'chat.continueInGoogle': ["Continue in the Google window.", "Continúa en la ventana de Google.", "Continue dans la fenêtre Google.", "Fahre im Google-Fenster fort.", "Continue na janela do Google."],
  'chat.note': ["Ask Lamiss anything about this video. Your question is tied to the moment you ask it. Lamiss's questions and your answers show up here too.", "Pregúntale a Lamiss lo que quieras sobre este vídeo. Tu pregunta queda ligada al momento en que la haces. Las preguntas de Lamiss y tus respuestas también aparecen aquí.", "Pose à Lamiss n'importe quelle question sur cette vidéo. Ta question est liée au moment où tu la poses. Les questions de Lamiss et tes réponses s'affichent aussi ici.", "Frag Lamiss alles zu diesem Video. Deine Frage gehört zu dem Moment, in dem du sie stellst. Die Fragen von Lamiss und deine Antworten erscheinen auch hier.", "Pergunte à Lamiss qualquer coisa sobre este vídeo. Sua pergunta fica ligada ao momento em que você a faz. As perguntas da Lamiss e suas respostas também aparecem aqui."],
  'chat.yourQuestion': ["Your question", "Tu pregunta", "Ta question", "Deine Frage", "Sua pergunta"],
  'chat.placeholder': ["Ask about this video…", "Pregunta sobre este vídeo…", "Pose une question sur cette vidéo…", "Frag etwas zu diesem Video…", "Pergunte sobre este vídeo…"],
  'chat.askVoice': ["Ask with your voice", "Pregunta con tu voz", "Pose ta question à voix haute", "Mit deiner Stimme fragen", "Pergunte com sua voz"],
  'chat.stopRecordingAndSend': ["Stop recording and send", "Detener la grabación y enviar", "Arrêter l'enregistrement et envoyer", "Aufnahme beenden und senden", "Parar a gravação e enviar"],
  'chat.stopAndSend': ["Stop and send", "Detener y enviar", "Arrêter et envoyer", "Beenden und senden", "Parar e enviar"],
  'chat.send': ["Send", "Enviar", "Envoyer", "Senden", "Enviar"],
  'chat.sendQuestion': ["Send question", "Enviar pregunta", "Envoyer la question", "Frage senden", "Enviar pergunta"],
  'chat.you': ["You", "Tú", "Toi", "Du", "Você"],
  'chat.thinking': ["Lamiss is thinking", "Lamiss está pensando", "Lamiss réfléchit", "Lamiss denkt nach", "A Lamiss está pensando"],
  'chat.couldNotLoad': ["Couldn't load the conversation so far: {error}", "No se pudo cargar la conversación: {error}", "Impossible de charger la conversation : {error}", "Die bisherige Unterhaltung konnte nicht geladen werden: {error}", "Não foi possível carregar a conversa: {error}"],
  'chat.openFromVideo': ["Open this chat from a YouTube video", "Abre este chat desde un vídeo de YouTube", "Ouvre ce chat depuis une vidéo YouTube", "Öffne diesen Chat aus einem YouTube-Video", "Abra este chat a partir de um vídeo do YouTube"],
  'chat.couldNotStart': ["Could not start a session", "No se pudo iniciar una sesión", "Impossible de démarrer une session", "Sitzung konnte nicht gestartet werden", "Não foi possível iniciar uma sessão"],
  'chat.resumed': ["Resumed session {id}", "Sesión {id} reanudada", "Session {id} reprise", "Sitzung {id} fortgesetzt", "Sessão {id} retomada"],
  'chat.started': ["Started session {id}", "Sesión {id} iniciada", "Session {id} démarrée", "Sitzung {id} gestartet", "Sessão {id} iniciada"],
  'chat.notReady': ["Lamiss hasn't finished learning this video yet, so questions may fail for a moment.", "Lamiss aún no ha terminado de aprender este vídeo, así que las preguntas pueden fallar un momento.", "Lamiss n'a pas encore fini d'apprendre cette vidéo, les questions peuvent donc échouer un instant.", "Lamiss hat dieses Video noch nicht fertig gelernt, daher können Fragen kurz fehlschlagen.", "A Lamiss ainda não terminou de aprender este vídeo, então as perguntas podem falhar por um momento."],
  'chat.emptyAnswer': ["Lamiss returned an empty answer.", "Lamiss devolvió una respuesta vacía.", "Lamiss a renvoyé une réponse vide.", "Lamiss hat eine leere Antwort geliefert.", "A Lamiss retornou uma resposta vazia."],
  'chat.couldNotAnswer': ["Lamiss couldn't answer: {error}", "Lamiss no pudo responder: {error}", "Lamiss n'a pas pu répondre : {error}", "Lamiss konnte nicht antworten: {error}", "A Lamiss não conseguiu responder: {error}"],
  'chat.allowMicTab': ["Allow microphone access in the tab that just opened, then tap the mic again.", "Permite el acceso al micrófono en la pestaña que se acaba de abrir y vuelve a pulsar el micrófono.", "Autorise l'accès au micro dans l'onglet qui vient de s'ouvrir, puis appuie à nouveau sur le micro.", "Erlaube den Mikrofonzugriff im gerade geöffneten Tab und tippe dann noch einmal auf das Mikrofon.", "Permita o acesso ao microfone na aba que acabou de abrir e toque no microfone de novo."],
  'chat.tooShort': ["That was too short. Tap the mic and ask again.", "Ha sido demasiado corto. Pulsa el micrófono y vuelve a preguntar.", "C'était trop court. Appuie sur le micro et repose ta question.", "Das war zu kurz. Tippe auf das Mikrofon und frag noch einmal.", "Foi curto demais. Toque no microfone e pergunte de novo."],
  'chat.voiceQuestion': ["Voice question…", "Pregunta por voz…", "Question vocale…", "Sprachfrage…", "Pergunta por voz…"],

  // --- On the YouTube page -----------------------------------------------------------------
  'page.start': ["Start using Lamiss", "Empezar a usar Lamiss", "Utiliser Lamiss", "Lamiss verwenden", "Começar a usar a Lamiss"],
  'page.loadingTranscript': ["Loading transcript…", "Cargando transcripción…", "Chargement de la transcription…", "Transkript wird geladen…", "Carregando transcrição…"],
  'page.ready': ["Lamiss is ready", "Lamiss está lista", "Lamiss est prête", "Lamiss ist bereit", "A Lamiss está pronta"],
  'page.retry': ["Retry Lamiss", "Reintentar Lamiss", "Relancer Lamiss", "Lamiss erneut versuchen", "Tentar a Lamiss de novo"],
  'page.idleDetail': ["Send this video's transcript to Lamiss", "Enviar la transcripción de este vídeo a Lamiss", "Envoyer la transcription de cette vidéo à Lamiss", "Das Transkript dieses Videos an Lamiss senden", "Enviar a transcrição deste vídeo para a Lamiss"],
  'page.signedOutDetail': ["Sign in with Google to use Lamiss", "Inicia sesión con Google para usar Lamiss", "Connecte-toi avec Google pour utiliser Lamiss", "Melde dich mit Google an, um Lamiss zu nutzen", "Entre com o Google para usar a Lamiss"],
  'page.badgeMonitoring': ["Lamiss is connected and following the video", "Lamiss está conectada y sigue el vídeo", "Lamiss est connectée et suit la vidéo", "Lamiss ist verbunden und folgt dem Video", "A Lamiss está conectada e acompanhando o vídeo"],
  'page.badgeConnecting': ["Reconnecting to Lamiss…", "Reconectando con Lamiss…", "Reconnexion à Lamiss…", "Verbindung zu Lamiss wird wiederhergestellt…", "Reconectando à Lamiss…"],
  'page.badgeQuestion': ["Lamiss is asking you a question", "Lamiss te está haciendo una pregunta", "Lamiss te pose une question", "Lamiss stellt dir eine Frage", "A Lamiss está fazendo uma pergunta"],
  'page.badgeError': ["Lamiss had a problem", "Lamiss tuvo un problema", "Lamiss a rencontré un problème", "Lamiss hatte ein Problem", "A Lamiss teve um problema"],
  'page.toggleChat': ["Click to show or hide the chat", "Haz clic para mostrar u ocultar el chat", "Clique pour afficher ou masquer le chat", "Klicke, um den Chat ein- oder auszublenden", "Clique para mostrar ou ocultar o chat"],
  'page.chatFrame': ["Lamiss chat", "Chat de Lamiss", "Chat Lamiss", "Lamiss-Chat", "Chat da Lamiss"],
  'page.signInFailedRetry': ["Sign-in failed. Click to try again", "No se pudo iniciar sesión. Haz clic para reintentar", "La connexion a échoué. Clique pour réessayer", "Anmeldung fehlgeschlagen. Klicke, um es erneut zu versuchen", "Não foi possível entrar. Clique para tentar novamente"],
  'page.sessionEnded': ["Your Lamiss session ended. Click to sign in again", "Tu sesión de Lamiss ha terminado. Haz clic para volver a iniciar sesión", "Ta session Lamiss a pris fin. Clique pour te reconnecter", "Deine Lamiss-Sitzung ist abgelaufen. Klicke, um dich erneut anzumelden", "Sua sessão da Lamiss terminou. Clique para entrar novamente"],
  'page.loadingDetail': ["Loading the transcript and sending it to Lamiss…", "Cargando la transcripción y enviándola a Lamiss…", "Chargement de la transcription et envoi à Lamiss…", "Das Transkript wird geladen und an Lamiss gesendet…", "Carregando a transcrição e enviando para a Lamiss…"],
  'page.transcriptFailed': ["Transcript failed", "Falló la transcripción", "La transcription a échoué", "Transkript fehlgeschlagen", "A transcrição falhou"],
  'page.backendHttp': ["Lamiss backend returned HTTP {status}", "El servidor de Lamiss devolvió HTTP {status}", "Le serveur Lamiss a renvoyé HTTP {status}", "Der Lamiss-Server hat HTTP {status} zurückgegeben", "O servidor da Lamiss retornou HTTP {status}"],
  'page.transcriptAlready': ["This video's transcript was already in Lamiss", "La transcripción de este vídeo ya estaba en Lamiss", "La transcription de cette vidéo était déjà dans Lamiss", "Das Transkript dieses Videos war schon in Lamiss", "A transcrição deste vídeo já estava na Lamiss"],
  'page.transcriptSent': ["Transcript sent to Lamiss", "Transcripción enviada a Lamiss", "Transcription envoyée à Lamiss", "Transkript an Lamiss gesendet", "Transcrição enviada para a Lamiss"],
  'page.noQuestionsHere': ["Lamiss can't ask you questions here: {detail}", "Lamiss no puede hacerte preguntas aquí: {detail}", "Lamiss ne peut pas te poser de questions ici : {detail}", "Lamiss kann dir hier keine Fragen stellen: {detail}", "A Lamiss não pode fazer perguntas aqui: {detail}"],
  'page.connectionRefused': ["connection refused", "conexión rechazada", "connexion refusée", "Verbindung abgelehnt", "conexão recusada"],
  'question.micNeeded': ["Lamiss needs the microphone. Allow it in the tab that just opened, then tap the mic. You can also type your answer.", "Lamiss necesita el micrófono. Permítelo en la pestaña que se acaba de abrir y pulsa el micrófono. También puedes escribir tu respuesta.", "Lamiss a besoin du micro. Autorise-le dans l'onglet qui vient de s'ouvrir, puis appuie sur le micro. Tu peux aussi écrire ta réponse.", "Lamiss braucht das Mikrofon. Erlaube es im gerade geöffneten Tab und tippe dann auf das Mikrofon. Du kannst deine Antwort auch eintippen.", "A Lamiss precisa do microfone. Permita na aba que acabou de abrir e toque no microfone. Você também pode digitar sua resposta."],
  'question.spokenFailed': ["I couldn't get your spoken answer ({error}). Tap the mic to try again, or type it.", "No pude entender tu respuesta hablada ({error}). Pulsa el micrófono para reintentar o escríbela.", "Je n'ai pas pu récupérer ta réponse orale ({error}). Appuie sur le micro pour réessayer, ou écris-la.", "Ich konnte deine gesprochene Antwort nicht erfassen ({error}). Tippe auf das Mikrofon, um es erneut zu versuchen, oder tippe sie ein.", "Não consegui captar sua resposta falada ({error}). Toque no microfone para tentar de novo ou digite."],
  'question.yourAnswer': ["Your answer", "Tu respuesta", "Ta réponse", "Deine Antwort", "Sua resposta"],
  'question.asksAt': ["Lamiss asks · {time}", "Lamiss pregunta · {time}", "Lamiss demande · {time}", "Lamiss fragt · {time}", "A Lamiss pergunta · {time}"],
  'question.asks': ["Lamiss asks", "Lamiss pregunta", "Lamiss demande", "Lamiss fragt", "A Lamiss pergunta"],
  'question.disconnected': ["Lamiss is disconnected, so your answer can't be saved.", "Lamiss está desconectada, así que tu respuesta no se puede guardar.", "Lamiss est déconnectée, ta réponse ne peut donc pas être enregistrée.", "Lamiss ist getrennt, daher kann deine Antwort nicht gespeichert werden.", "A Lamiss está desconectada, então sua resposta não pode ser salva."],
  'question.reconnectQueued': ["Reconnecting to Lamiss… your answer will be sent as soon as it's back.", "Reconectando con Lamiss… tu respuesta se enviará en cuanto vuelva.", "Reconnexion à Lamiss… ta réponse sera envoyée dès son retour.", "Verbindung zu Lamiss wird wiederhergestellt… deine Antwort wird gesendet, sobald sie zurück ist.", "Reconectando à Lamiss… sua resposta será enviada assim que ela voltar."],
  'question.reconnectNotSaved': ["Reconnecting to Lamiss… your answer hasn't been saved yet.", "Reconectando con Lamiss… tu respuesta aún no se ha guardado.", "Reconnexion à Lamiss… ta réponse n'a pas encore été enregistrée.", "Verbindung zu Lamiss wird wiederhergestellt… deine Antwort wurde noch nicht gespeichert.", "Reconectando à Lamiss… sua resposta ainda não foi salva."],
  'question.asking': ["Lamiss is asking…", "Lamiss está preguntando…", "Lamiss pose sa question…", "Lamiss fragt…", "A Lamiss está perguntando…"],
  'question.listeningCountdown': ["Listening… start answering ({seconds}s)", "Escuchando… empieza a responder ({seconds} s)", "J'écoute… commence à répondre ({seconds} s)", "Ich höre zu… fang an zu antworten ({seconds} s)", "Ouvindo… comece a responder ({seconds}s)"],
  'question.recording': ["Listening… I'll stop when you finish talking.", "Escuchando… pararé cuando termines de hablar.", "J'écoute… j'arrêterai quand tu auras fini de parler.", "Ich höre zu… ich höre auf, wenn du fertig bist.", "Ouvindo… vou parar quando você terminar de falar."],
  'question.transcribing': ["Getting your answer…", "Obteniendo tu respuesta…", "Récupération de ta réponse…", "Deine Antwort wird erfasst…", "Pegando sua resposta…"],
  'question.checking': ["Lamiss is checking your answer…", "Lamiss está revisando tu respuesta…", "Lamiss vérifie ta réponse…", "Lamiss prüft deine Antwort…", "A Lamiss está verificando sua resposta…"],
  'question.placeholderSpeak': ["Answer out loud, or type here…", "Responde en voz alta o escribe aquí…", "Réponds à voix haute, ou écris ici…", "Antworte laut oder tippe hier…", "Responda em voz alta ou digite aqui…"],
  'question.placeholderType': ["Type your answer…", "Escribe tu respuesta…", "Écris ta réponse…", "Tippe deine Antwort…", "Digite sua resposta…"],
  'question.doneTalking': ["Done talking", "He terminado", "J'ai fini", "Fertig gesprochen", "Terminei de falar"],
  'question.stopListening': ["Stop listening", "Dejar de escuchar", "Arrêter l'écoute", "Zuhören beenden", "Parar de ouvir"],
  'question.answerVoice': ["Answer with your voice", "Responder con tu voz", "Répondre à voix haute", "Mit deiner Stimme antworten", "Responder com sua voz"],
  'question.continue': ["Continue", "Continuar", "Continuer", "Weiter", "Continuar"],
  'question.close': ["Close", "Cerrar", "Fermer", "Schließen", "Fechar"],
  'question.checkingShort': ["Checking…", "Revisando…", "Vérification…", "Wird geprüft…", "Verificando…"],
  'question.answer': ["Answer", "Responder", "Répondre", "Antworten", "Responder"],
  'question.correct': ["✓ Correct.", "✓ Correcto.", "✓ Correct.", "✓ Richtig.", "✓ Correto."],
  'question.notQuite': ["✗ Not quite.", "✗ No del todo.", "✗ Pas tout à fait.", "✗ Nicht ganz.", "✗ Não exatamente."],
  'question.couldNotCheck': ["Lamiss couldn't check your answer: {error}. Try again.", "Lamiss no pudo revisar tu respuesta: {error}. Inténtalo de nuevo.", "Lamiss n'a pas pu vérifier ta réponse : {error}. Réessaie.", "Lamiss konnte deine Antwort nicht prüfen: {error}. Versuche es erneut.", "A Lamiss não conseguiu verificar sua resposta: {error}. Tente novamente."],
  'timer.title': ["Time until Lamiss's next question. Click to change how often and how hard.", "Tiempo hasta la próxima pregunta de Lamiss. Haz clic para cambiar la frecuencia y la dificultad.", "Temps avant la prochaine question de Lamiss. Clique pour changer la fréquence et la difficulté.", "Zeit bis zur nächsten Frage von Lamiss. Klicke, um Häufigkeit und Schwierigkeit zu ändern.", "Tempo até a próxima pergunta da Lamiss. Clique para mudar a frequência e a dificuldade."],
  'timer.off': ["Questions off", "Preguntas desactivadas", "Questions désactivées", "Fragen aus", "Perguntas desativadas"],
  'timer.connecting': ["Connecting…", "Conectando…", "Connexion…", "Verbindung wird hergestellt…", "Conectando…"],
  'timer.asking': ["Lamiss is asking", "Lamiss está preguntando", "Lamiss pose une question", "Lamiss fragt", "A Lamiss está perguntando"],
  'timer.next': ["Next question…", "Próxima pregunta…", "Prochaine question…", "Nächste Frage…", "Próxima pergunta…"],
  'timer.waiting': ["Waiting for your answer", "Esperando tu respuesta", "En attente de ta réponse", "Warte auf deine Antwort", "Esperando sua resposta"],
  'timer.noMore': ["No more questions ahead", "No hay más preguntas", "Plus de questions à venir", "Keine weiteren Fragen", "Não há mais perguntas"],
  'timer.anySecond': ["Next question any second", "Próxima pregunta en un momento", "Prochaine question dans un instant", "Nächste Frage gleich", "Próxima pergunta a qualquer momento"],
  'timer.inPaused': ["Next question in {countdown} · paused", "Próxima pregunta en {countdown} · en pausa", "Prochaine question dans {countdown} · en pause", "Nächste Frage in {countdown} · pausiert", "Próxima pergunta em {countdown} · pausado"],
  'timer.in': ["Next question in {countdown}", "Próxima pregunta en {countdown}", "Prochaine question dans {countdown}", "Nächste Frage in {countdown}", "Próxima pergunta em {countdown}"],
  'popover.howClose': ["How close together", "Con qué frecuencia", "À quel rythme", "Wie dicht hintereinander", "Com que frequência"],
  'popover.hint': ["Saved in this browser only. Lamiss only asks about parts you've already watched.", "Se guarda solo en este navegador. Lamiss solo pregunta sobre partes que ya has visto.", "Enregistré dans ce navigateur uniquement. Lamiss ne pose des questions que sur ce que tu as déjà vu.", "Nur in diesem Browser gespeichert. Lamiss fragt nur nach Teilen, die du schon gesehen hast.", "Salvo só neste navegador. A Lamiss só pergunta sobre partes que você já assistiu."],

  // --- Microphone permission page ----------------------------------------------------------
  'permission.title': ["Enable your microphone", "Activa tu micrófono", "Active ton micro", "Aktiviere dein Mikrofon", "Ative seu microfone"],
  'permission.intro': ["Lamiss needs microphone access so you can ask questions out loud. Chrome will ask you once.", "Lamiss necesita acceso al micrófono para que puedas hacer preguntas en voz alta. Chrome te lo pedirá una vez.", "Lamiss a besoin d'accéder au micro pour que tu puisses poser tes questions à voix haute. Chrome te le demandera une fois.", "Lamiss braucht Zugriff auf das Mikrofon, damit du laut Fragen stellen kannst. Chrome fragt dich einmal.", "A Lamiss precisa de acesso ao microfone para você fazer perguntas em voz alta. O Chrome vai pedir uma vez."],
  'permission.granted': ["Microphone enabled. Close this tab and ask Lamiss from the extension popup.", "Micrófono activado. Cierra esta pestaña y pregúntale a Lamiss desde la ventana de la extensión.", "Micro activé. Ferme cet onglet et pose tes questions à Lamiss depuis la fenêtre de l'extension.", "Mikrofon aktiviert. Schließe diesen Tab und frag Lamiss über das Popup der Erweiterung.", "Microfone ativado. Feche esta aba e pergunte à Lamiss pela janela da extensão."],
  'permission.denied': ["Microphone access was blocked. Click the icon at the right of the address bar to allow it, then try again.", "Se bloqueó el acceso al micrófono. Haz clic en el icono a la derecha de la barra de direcciones para permitirlo y vuelve a intentarlo.", "L'accès au micro a été bloqué. Clique sur l'icône à droite de la barre d'adresse pour l'autoriser, puis réessaie.", "Der Mikrofonzugriff wurde blockiert. Klicke auf das Symbol rechts in der Adressleiste, um ihn zu erlauben, und versuche es dann erneut.", "O acesso ao microfone foi bloqueado. Clique no ícone à direita da barra de endereço para permitir e tente novamente."]
} satisfies Record<string, LamissMessageTexts>;

type LamissMessageKey = keyof typeof LAMISS_MESSAGES;

function isLamissAppLanguage(value: unknown): value is LamissAppLanguage {
  return typeof value === 'string' && LAMISS_APP_LANGUAGES.some(language => language.code === value);
}

// Before anything is chosen: the browser's language when it is one of the
// five, else English.
function lamissDefaultAppLanguage(): LamissAppLanguage {
  let browserLanguage = '';
  try {
    browserLanguage = chrome.i18n?.getUILanguage?.() ?? '';
  } catch {
    // Not available in this context.
  }
  if (!browserLanguage && typeof navigator !== 'undefined') {
    browserLanguage = navigator.language ?? '';
  }
  const primary = browserLanguage.split('-')[0].toLowerCase();
  return isLamissAppLanguage(primary) ? primary : 'en';
}

// What this page shows now. Every page reads it from storage once it loads
// (loadAppLanguage) and follows changes made on any other page.
let lamissAppLanguage: LamissAppLanguage = lamissDefaultAppLanguage();
const lamissAppLanguageListeners: Array<(language: LamissAppLanguage) => void> = [];

function lamissT(key: LamissMessageKey, params: Record<string, string | number> = {}): string {
  const texts = LAMISS_MESSAGES[key] as LamissMessageTexts | undefined;
  if (!texts) {
    return key;
  }
  const text = texts[LAMISS_MESSAGE_INDEX[lamissAppLanguage]];
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => name in params ? String(params[name]) : placeholder);
}

async function loadAppLanguage(): Promise<LamissAppLanguage> {
  try {
    const stored = await chrome.storage.local.get(LAMISS_APP_LANGUAGE_KEY);
    const value = stored[LAMISS_APP_LANGUAGE_KEY];
    if (isLamissAppLanguage(value)) {
      lamissAppLanguage = value;
    }
  } catch {
    // No storage here (the offscreen document): keep the default.
  }
  return lamissAppLanguage;
}

// Every open page (this one included) follows through onAppLanguageChange.
async function saveAppLanguage(language: LamissAppLanguage): Promise<void> {
  await chrome.storage.local.set({ [LAMISS_APP_LANGUAGE_KEY]: language });
}

function onAppLanguageChange(listener: (language: LamissAppLanguage) => void): void {
  lamissAppLanguageListeners.push(listener);
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[LAMISS_APP_LANGUAGE_KEY];
    if (area !== 'local' || !change) {
      return;
    }
    const next = isLamissAppLanguage(change.newValue) ? change.newValue : lamissDefaultAppLanguage();
    if (next === lamissAppLanguage) {
      return;
    }
    lamissAppLanguage = next;
    lamissAppLanguageListeners.forEach(listener => listener(next));
  });
} catch {
  // No storage here (the offscreen document).
}

// Fills the static text of a page: data-i18n="key" sets the text, and
// data-i18n-attr="aria-label:key;title:key" sets attributes.
function applyLamissTranslations(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = lamissT(element.dataset.i18n as LamissMessageKey);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (element.dataset.i18nAttr ?? '').split(';')) {
      const [attribute, key] = pair.split(':').map(part => part.trim());
      if (attribute && key) {
        element.setAttribute(attribute, lamissT(key as LamissMessageKey));
      }
    }
  }
  if (root === document) {
    document.documentElement.lang = lamissAppLanguage;
  }
}
