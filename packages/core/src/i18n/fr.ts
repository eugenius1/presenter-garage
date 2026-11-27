import type { Dictionary } from "./en";

/**
 * French strings.
 *
 * Typed as `Dictionary`, so any key missing from here -- or present but
 * misspelled -- is a build error rather than an English string leaking into a
 * French interface.
 *
 * Narrow no-break spaces (U+202F) sit before colons and inside guillemets,
 * as French typography requires.
 */
export const fr: Dictionary = {
  meta: {
    localeTag: "fr",
    name: "Français",
    quoteOpen: "\u00ab\u202f",
    quoteClose: "\u202f\u00bb",
    colon: "\u202f: ",
  },

  app: {
    title: "Presenter Garage",
    offline: "Fonctionne sur votre appareil",
    offlineHelp: "Les fichiers sont lus dans votre navigateur. Rien n'est envoyé.",
    schemaHelp: "{files} fichiers proto, générés le {date}",
    languageLabel: "Langue",
    toolLabel: "Outil",
    themeLabel: "Apparence",
    copyright: "\u00a9 {years}",
    licence: "Open source",
    footnoteBefore: "Schéma {version} issu de",
    footnoteLink: "greyshirtguy/ProPresenter7-Proto",
    footnoteAfter: "Sans lien avec Renewed Vision.",
  },

  assistants: {
    heading: "Pour les assistants IA",
    lead:
      "Permettez à un assistant comme Claude de lire votre bibliothèque ProPresenter sur le disque, d'y lancer ces vérifications et de corriger le texte des diapositives une fois chaque ligne cochée. Il ne lit rien en dehors des dossiers que vous choisissez et sauvegarde chaque fichier avant de le modifier.",
    privacy:
      "Contrairement à cette page, ce qu'il lit ne reste pas sur votre ordinateur : texte des diapositives, notes et noms de fichiers partent dans votre conversation avec l'assistant.",
    desktopHeading: "Claude Desktop",
    desktopDownload: "Télécharger l'extension (.mcpb)",
    desktopHelp: "Ouvrez-la avec Claude Desktop, puis choisissez votre dossier ProPresenter.",
    cliHeading: "Claude Code et autres clients MCP",
    cliHelp: "À lancer dans un terminal. Nécessite Node 20 ou plus récent.",
    copy: "Copier",
    copied: "Copié",
    copyFailed: "Sélectionnez la commande et copiez-la",
    guide: "Guide d'installation complet",
  },


  fidelity: {
    identical: "sans perte",
    equivalent: "sans perte*",
    lossy: "avec perte — ne pas exporter",
    identicalHelp:
      "Le réencodage de ce fichier le reproduit octet pour octet : l'export est donc sûr.",
    equivalentHelp:
      "Le réencodage modifie la disposition des octets mais pas le contenu : rien ne serait perdu à l'export.",
    lossyHelp:
      "Le réencodage de ce fichier perd du contenu — il contient un élément que le schéma ne couvre pas. Un export risquerait de corrompre votre bibliothèque.",
  },

  errors: {
    empty: "Ce fichier est vide.",
    notProtobuf:
      "Ce n'est pas un fichier de liste ProPresenter (échec du décodage protobuf : {reason})",
    wrongPlaylistType: "Il s'agit d'une liste {actual}, pas d'une liste {expected}.",
    playlistType: {
      unknown: "inconnue",
      presentation: "de présentations",
      media: "de médias",
      audio: "audio",
    },
    pickFileHint:
      "Choisissez le fichier nommé « {filename} » dans votre dossier ProPresenter.",
  },



  diff: {
    summary: "Résumé",
    identical: "Les deux fichiers décrivent une bibliothèque de médias identique.",
    changeCount: [
      "{n} changement sur {from} → {to} éléments.",
      "{n} changements sur {from} → {to} éléments.",
    ],
    playlistStructure: "Structure des listes",
    changes: "Changements",
    method:
      "Appariement d'abord par UUID d'élément, puis par chemin du média. La comparaison ignore les chemins absolus enregistrés : déplacer une bibliothèque d'une machine ou d'un dossier à l'autre n'est donc pas signalé comme un changement.",
    pathMatch: "par chemin",
    pathMatchHelp: "apparié par chemin de fichier, pas par UUID",
    inPlaylist: "dans {playlist}",
    root: "(racine)",
    unmodified: "sans retouche",
    wasIn: "était dans {playlist}",
    nowIn: "désormais dans {playlist}",
    types: {
      added: "Ajouté",
      removed: "Supprimé",
      moved: "Déplacé",
      renamed: "Renommé",
      relinked: "Relié",
      restyled: "Retouché",
      retimed: "Minutage",
    },
    explain: {
      added: "média présent uniquement dans le fichier le plus récent",
      removed: "média présent uniquement dans le fichier le plus ancien",
      moved: "même média, liste différente",
      renamed: "même média, libellé différent dans ProPresenter",
      relinked: "même élément, pointant désormais vers un autre fichier",
      restyled: "même média, miroir, recadrage ou effets modifiés",
      retimed: "même média, réglages de lecture ou de transition modifiés",
    },
    playlistTypes: {
      added: "nouvelle liste",
      removed: "liste absente désormais",
      renamed: "renommée",
      recreated: "supprimée puis recréée — {before} éléments avant, {after} après",
    },
    recreated: "Recréée",
  },

  playback: {
    transitionDuration: "durée de transition",
    playbackBehavior: "lecture",
    endBehavior: "comportement en fin",
    timesToLoop: "nombre de boucles",
    loopTime: "durée de boucle",
    softLoop: "boucle douce",
    markerCount: "marqueurs",
    effectCount: "effets",
    seconds: "{n} s",
    none: "—",
    yes: "oui",
    no: "non",
  },

  mods: {
    mirroredHorizontally: "miroir horizontal",
    mirroredVertically: "miroir vertical",
    rotated: "pivoté de {degrees}°",
    blurred: "flou",
    alphaInverted: "alpha inversé",
    cropped: "recadré",
    effect: "effet : {name}",
    effectOff: "effet : {name} (désactivé)",
  },

  library: {
    heading: "Bibliothèque",
    appOn: "ProPresenter {version} sur {platform}",
    items: "Éléments",
    playlists: "Listes",
    video: "Vidéo",
    image: "Image",
    audio: "Audio",
    other: "Autre",
    modified: "Retouchés",
  },

  audit: {
    heading: "Constats",
    method:
      "Deux entrées ne comptent comme doublons que si elles partagent un fichier et un jeu de retouches identique. Un même fichier avec un miroir, un recadrage ou des effets différents est une variante voulue, listée séparément.",
    nothing: "Rien à signaler.",
    more: ["{n} de plus", "{n} de plus"],

    withinPlaylist: "Répété dans une même liste",
    withinPlaylistWhy:
      "Le même fichier avec les mêmes retouches apparaît plusieurs fois dans une seule liste. Rarement voulu.",
    labelled: "libellé {labels}",
    allWith: "tous avec : {mods}",

    crossPlaylist: "Entrées identiques dans plusieurs listes",
    crossPlaylistWhy:
      "Un fichier, un jeu de retouches, accessible depuis plusieurs listes. En général un classement voulu — mais lorsque les libellés diffèrent, il vaut la peine de vérifier lequel est le bon.",

    variants: "Variantes d'un même fichier",
    variantsWhy:
      "Ces entrées partagent un fichier source mais chacune applique ses propres retouches : ce sont donc bien des contenus différents. Ce n'est pas un problème — c'est affiché parce que ProPresenter ne permet pas de voir quelles variantes existent.",
    unnamed: "(sans nom)",

    locations: "Emplacements enregistrés incohérents",
    locationsWhy:
      "Les éléments enregistrent des racines absolues différentes, signe que la bibliothèque a changé de dossier, de compte utilisateur ou de machine. Sans conséquence en soi — ProPresenter résout les médias par le chemin relatif — et c'est précisément pourquoi cet outil compare sur le chemin relatif.",
    locationCount: ["{n} élément", "{n} éléments"],

    external: "Médias sur volumes externes",
    externalWhy:
      "Ceux-ci sont résolus par rapport à un disque nommé et non au dossier ProPresenter. Ils disparaissent dès que ce disque n'est pas monté.",

    empty: "Listes vides",
    emptyWhy: "Listes ne contenant aucun média ni sous-liste.",

    hidden: "Éléments masqués",
    hiddenWhy: "Marqués masqués dans ProPresenter : ils n'apparaîtront pas dans le chutier.",

    nameMismatch: "Le libellé diffère du nom de fichier",
    nameMismatchWhy:
      "Entrées sans retouche dont le libellé ne ressemble pas au fichier visé. Renommer est courant, la plupart sont donc normales — occasionnellement c'est la trace d'un élément mal relié.",
  },

  browse: {
    heading: "Parcourir",
    subtitle: "{items} dans {playlists}.",
    items: ["{n} élément", "{n} éléments"],
    playlists: ["{n} liste", "{n} listes"],
    search: "Rechercher un élément, un nom de fichier ou une liste…",
    matches: ["{n} résultat", "{n} résultats"],
    itemCount: ["{n} élément", "{n} éléments"],
    subCount: ["{n} sous-liste", "{n} sous-listes"],
    empty: "vide",
    unnamed: "(sans nom)",
  },

  themes: {
    system: "Système",
    light: "Clair",
    dark: "Sombre",
  },

  tools: {
    presentations: {
      name: "Présentations",
      tagline: "Vérifier le texte de toutes les présentations d'une bibliothèque",

      pickFolder: "Choisir un dossier…",
      pickFiles: "Choisir des fichiers .pro…",
      scanning: "Lecture de {n}…",
      chooseHint:
        "Choisissez votre espace de travail ProPresenter, ou son dossier Libraries. Tout est lu dans votre navigateur ; rien n'est envoyé.",
      readwriteNote:
        "Ce navigateur peut lire le dossier et y enregistrer les corrections.",
      readonlyNote:
        "Ce navigateur peut lire un dossier mais pas y écrire. Safari et Firefox n'offrent aucun retour vers les fichiers d'origine — utilisez Chrome ou Edge pour enregistrer les corrections sur place.",
      unavailableNote:
        "Ce navigateur ne peut pas lire de dossier. Choisissez les fichiers .pro un à un.",

      found: ["{n} présentation", "{n} présentations"],
      noneFound: "Aucun fichier .pro trouvé dans {folder}. Les présentations se trouvent dans le dossier Libraries d'un espace de travail ProPresenter — choisissez celui-ci, ou l'espace de travail lui-même.",
      pickerFailed:
        "Le sélecteur de dossier n'était pas disponible ; les fichiers ont été lus sous forme de copies. Les corrections ne peuvent pas être réenregistrées ainsi.",
      summary: "Résumé",
      changeFolder: "Changer",
      clearFolder: "Effacer",
      remembered: "{folder} était ouvert la dernière fois.",
      reconnect: "Rouvrir {folder}",
      reconnectWhy:
        "L'autorisation de lire le dossier a expiré à la fermeture de l'onglet. La rouvrir demande un clic.",
      forgetFolder: "Oublier ce dossier",
      clean: "Aucun problème de texte trouvé.",
      issuesFound: ["{n} problème dans {files}", "{n} problèmes dans {files}"],
      inFiles: ["{n} fichier", "{n} fichiers"],
      slidesAndBoxes: "{slides} diapositives · {empty} zones de texte vides",
      problems: {
        empty: "Ce fichier est vide.",
        notPresentation:
          "Ceci est un fichier texte, pas une présentation ProPresenter. Les grilles d’accords utilisent aussi l’extension .pro : un fichier ChordPro ou OnSong rangé dans une bibliothèque y ressemble tant qu’on ne l’ouvre pas.",
        unreadable: "Lecture impossible : {reason}",
      },

      slide: "diapositive {n}",
      line: "ligne {n}",
      kinds: {
        leadingSpace: "Espace au début",
        trailingSpace: "Espace à la fin",
        blankLine: "Ligne vide",
        repeatedSpace: "Espace double",
        trailingComma: "Virgule finale",
        trailingSemicolon: "Point-virgule final",
        trailingFullStop: "Point final",
      },
      why: {
        leadingSpace: "La ligne commence par une espace, ce qui la décale vers la droite à l'écran.",
        trailingSpace: "La ligne finit par une espace. Invisible dans l'éditeur, mais cela affecte le centrage.",
        blankLine: "Une ligne entre deux lignes de texte qui n'affiche rien — elle laisse un trou sur la diapositive.",
        repeatedSpace: "Deux espaces ou plus à la suite dans la ligne.",
        trailingComma:
          "La ligne se termine par une virgule. Normal dans un texte, mais cela se remarque en fin de diapositive.",
        trailingSemicolon:
          "La ligne se termine par un point-virgule, qui survit rarement à une coupure entre diapositives.",
        trailingFullStop:
          "La ligne se termine par un point. Une ligne qui se poursuit sur la diapositive suivante s’écrit avec des points de suspension, qui sont laissés tels quels.",
      },
      emptyBoxesNote:
        "Les zones de texte sans aucun texte sont comptées, pas listées : les thèmes ProPresenter en laissent systématiquement sur les diapositives.",
      optionalChecks: {
        trailingComma: "Rechercher aussi les virgules finales",
        trailingSemicolon: "Rechercher aussi les points-virgules finaux",
        trailingFullStop: "Rechercher aussi les points finaux",
      },
      optionalWhy: {
        trailingComma:
          "Désactivé par défaut : une virgule en fin de ligne est une ponctuation ordinaire, et sa place sur une diapositive relève du style de la maison.",
        trailingSemicolon:
          "Désactivé par défaut, et rare : 43 lignes sur 24 000 dans une bibliothèque réelle se terminent ainsi.",
        trailingFullStop:
          "Désactivé par défaut, et de loin le plus fréquent des trois : une maison qui supprime les virgules garde souvent le point qui termine un couplet.",
      },
      showAll: "Tout afficher ({n})",

      fix: "Corriger",
      fixHint:
        "Rien n’est écrit tant que vous n’avez pas de sauvegarde et que vous n’avez pas choisi quoi modifier. Chaque ligne est montrée telle qu’elle est et telle qu’elle deviendrait.",
      fixable: ["{n} ligne peut être corrigée", "{n} lignes peuvent être corrigées"],
      inFilesFix: ["dans {n} fichier", "dans {n} fichiers"],
      selectAll: "Tout sélectionner",
      selectNone: "Tout désélectionner",
      selectFile: "Sélectionner toutes les lignes de ce fichier",
      macroOff: "{name} (désactivée)",
      noTextOnSlide: "aucun texte sur cette diapositive",
      becomes: "devient",
      lineRemoved: "la ligne est supprimée",
      noFixFor: "Pas de correction automatique — cette ligne doit être modifiée dans ProPresenter.",
      downloadBackup: "Télécharger d’abord une sauvegarde",
      backupCount: ["Sauvegarde {n} fichier", "Sauvegarde {n} fichiers"],
      backupDone: "Sauvegardé sous {name}.",
      backupStale:
        "Votre sélection couvre maintenant des fichiers absents de la sauvegarde. Téléchargez-la de nouveau.",
      backupWhy:
        "Un zip des fichiers tels qu’ils sont aujourd’hui, placé dans vos téléchargements. Gardez-le jusqu’à ce que vous ayez ouvert les chants dans ProPresenter et qu’ils vous conviennent.",
      applyFixes: ["Corriger {n} ligne", "Corriger {n} lignes"],
      applying: "Enregistrement de {n}…",
      backingUp: "Sauvegarde de {n}…",
      fixing: "Correction de {n}…",
      progressCount: "{done} sur {total}",
      fixedFiles: ["{n} fichier corrigé", "{n} fichiers corrigés"],
      fixedNone: "Rien n’a été modifié.",
      fixFailed: ["{n} fichier a été laissé intact", "{n} fichiers ont été laissés intacts"],
      downloadFixed: "Télécharger les fichiers corrigés",
      downloadFixedWhy:
        "Ce navigateur ne peut pas écrire dans le dossier : les présentations corrigées arrivent donc sous forme de zip. Déplacez-les vous-même dans votre bibliothèque, en gardant les originaux jusqu’à ce qu’ils vous conviennent.",
      downloadedFixed:
        "Enregistré sous {name}. Votre bibliothèque n’a pas été touchée.",
      permissionNeeded:
        "L’enregistrement nécessite l’autorisation d’écrire dans le dossier. Choisissez de nouveau le dossier et autorisez la modification.",
      teamRules: {
        title: "Règles de l’équipe",
        hint: "Chargez le rules.json que votre équipe a compilé depuis son RULES.md. Ce que les règles trouvent est listé sous les corrections de texte, et rien n’est modifié à partir de là.",
        load: "Charger un rules.json…",
        useTeam: "Utiliser les règles de l’équipe",
        clear: "Ne plus utiliser de règles",
        loaded: "Règles utilisées\u202f: {name}",
        loadedTeam: "Les règles de l’équipe, depuis {file}",
        notJson: "Ce fichier n’est pas du JSON\u202f: {reason}",
        problems: "Ces règles sont inutilisables\u202f:",
        stale: "RULES.md a changé depuis la compilation de rules.json, ces règles sont peut-être périmées. Demandez à votre agent de le compiler de nouveau.",
        defaulted: "RULES.md n’a pas encore été compilé en rules.json\u202f: seules les vérifications de texte par défaut sont utilisées.",
        none: "Aucun RULES.md ni rules.json n’a été trouvé dans le dossier d’où l’application a été lancée, ni dans Documents/ProPresenter.",
        error: "Les règles de l’équipe n’ont pas pu être chargées\u202f: {message}",
        findings: ["{n} constat selon les règles", "{n} constats selon les règles"],
        lists: "Les listes de groupes et de macros de ProPresenter n’étaient pas toutes là, donc certaines règles avaient moins à vérifier\u202f:",
        nothingFound: "Les règles n’ont rien trouvé à signaler.",
      },
      native: {
        chooseHint:
          "Choisissez votre dossier ProPresenter, son dossier Libraries, ou l’un des espaces de travail ProPresenter 22 ci-dessous. Tout est lu sur cet ordinateur ; rien n’est envoyé.",
        note: "L’application lit le dossier directement et enregistre les corrections sur place, en sauvegardant chaque fichier avant de le modifier.",
        workspaces: "Espaces de travail ProPresenter 22 sur cet ordinateur",
        open: "Ouvrir",
        inUse: "celui qu’ouvre ProPresenter",
        cloud: "synchronisé avec ProPresenter Cloud",
        cloudReadOnly:
          "Cet espace de travail est synchronisé avec ProPresenter Cloud. Il peut être vérifié ici, mais l’application ne modifie pas encore un espace de travail Cloud. Faites les corrections dans ProPresenter lui-même.",
        closeProPresenter:
          "Ceci est un espace de travail ProPresenter 22. Quittez ProPresenter avant d’enregistrer : tant qu’il a l’espace de travail ouvert, rien n’est écrit.",
        backupWhy:
          "Chaque fichier est copié dans le dossier de sauvegarde de l’application et vérifié avant d’être modifié. Un fichier qui a changé depuis sa lecture est laissé tel quel.",
        backedUpTo: "Les fichiers tels qu’ils étaient se trouvent dans {folder}.",
        showBackups: "Afficher les sauvegardes",
        backupsUnshown: "Le dossier de sauvegarde n’a pas pu être ouvert. Il a peut-être été déplacé ou supprimé ; le chemin ci-dessus indique où les sauvegardes ont été faites.",
        truncated:
          "Ce dossier contient plus de présentations que ce qui est lu en une fois : elles ne sont donc pas toutes listées. Choisissez plutôt le dossier Libraries, ou une seule bibliothèque.",
      },
      // Dit avant qu’on choisisse des modifications dans un espace de travail ProPresenter Cloud.
      cloudWrite:
        "Ceci est un espace de travail ProPresenter Cloud. Une modification de la même zone de texte faite sur un autre ordinateur, et pas encore synchronisée ici, peut remplacer celle-ci à la prochaine synchronisation, la zone de texte tout entière.",
      runRefusals: {
        propresenterOpen:
          "ProPresenter a cet espace de travail ouvert : rien n’a été écrit, car une modification faite sous lui serait perdue à son prochain enregistrement. Quittez ProPresenter et enregistrez de nouveau.",
        cloudWorkspace:
          "Cet espace de travail est synchronisé avec ProPresenter Cloud, que l’application ne modifie pas encore, donc rien n’a été écrit. Faites la modification dans ProPresenter lui-même.",
        unverifiedWorkspace:
          "Le format de cet espace de travail n’est pas l’un de ceux que l’application a vérifiés : rien n’a donc été écrit. Faites la modification dans ProPresenter lui-même.",
        failed: "Rien n’a été écrit : {detail}",
      },
      refusals: {
        lossy:
          "ce fichier utilise quelque chose que le schéma ne couvre pas : l’enregistrer pourrait perdre des données",
        unreadable: "ce fichier n’a pas pu être lu",
        unchanged: "rien n’a été sélectionné dans ce fichier",
        verifyFailed:
          "le résultat ne s’est pas relu comme prévu : il n’a donc pas été enregistré",
        writeFailed: "le dossier a refusé le fichier",
        stale:
          "ce fichier a changé depuis l’analyse : la correction ne lui correspond plus",
        moved:
          "ce fichier n’est plus là où il était, ou il est désormais atteint par un lien symbolique",
        backupFailed:
          "une sauvegarde n’a pas pu être faite et vérifiée : ce fichier n’a donc pas été écrit",
        readBackFailed:
          "le fichier sur le disque ne contient pas ce qui a été écrit ; restaurez-le depuis la sauvegarde",
        attributeRanges:
          "une zone de texte porte une mise en forme qui ne peut pas suivre son texte sans deviner : rien n’a donc été écrit",
        rolledBack:
          "une autre présentation du même espace de travail n’a pas pu être écrite : aucune n’y a donc été écrite",
        newContainer:
          "la modification devrait ajouter quelque chose de nouveau dans un document de ProPresenter 22, comme une couleur pour un groupe qui n’en a pas, ce qui n’est pas fait",
        unsynced:
          "cette présentation Cloud a des modifications que ProPresenter Cloud n’a pas encore confirmées. Ouvrez ProPresenter, laissez-le synchroniser, quittez-le, puis réessayez",
      },
      rangeRefusals: {
        malformed: "une plage de mise en forme y finit avant de commencer",
        typedAtEdge:
          "du texte serait ajouté juste au bord d’une mise en forme qui ne couvre qu’une partie de la ligne, et rien ne dit s’il doit la prendre",
        replacedAcrossEdge:
          "du nouveau texte remplacerait l’endroit où commence ou finit une mise en forme sur une partie de la ligne, et rien ne dit où elle doit commencer ou finir dans le nouveau texte",
        addedLine:
          "une ligne serait ajoutée à côté d’une mise en forme autre que Tout en majuscules, ou au milieu d’une mise en forme qui ne couvre pas la ligne voisine, et rien ne dit si la nouvelle ligne doit la prendre",
        dependsOnChoice:
          "la mise en forme d’une ligne dépend d’une autre modification sur cette ligne ou à côté, qui pourrait être décochée : elle ne peut donc pas être montrée pour chaque choix ; planifiez ces modifications séparément",
      },
      editRefusals: {
        noSuchLine: "il n’y a pas de zone de texte ou de ligne à cette adresse",
        duplicate: "deux modifications visent la même ligne",
        unchanged: "la ligne se lit déjà ainsi",
        notOneLine:
          "le texte contient un saut de ligne ou un autre caractère de contrôle : il ne tient pas sur une ligne",
        lastLine: "la dernière ligne d’une zone de texte ne peut pas être supprimée, seulement vidée",
        emptyLine:
          "une ligne ajoutée doit contenir du texte : une ligne vide entre deux autres est justement ce que signale la vérification des lignes vides",
        besideRemoved:
          "impossible d’ajouter une ligne à côté d’une ligne que ce même plan supprime : elle en prendrait la mise en forme",
        unsupported:
          "la modification ne se relirait pas comme demandé une fois écrite : elle n’est donc pas proposée",
      },
      structureRefusals: {
        noSuchGroup: "il n’y a pas de groupe à cette adresse",
        noSuchSlide: "il n’y a pas de diapositive à cette adresse",
        duplicate: "deux modifications visent le même groupe, ou la même macro sur une diapositive",
        unchanged: "c’est déjà le cas",
        badName: "un nom de groupe demande du texte, sur une seule ligne",
        noSuchMacro: "la diapositive ne déclenche aucune macro de ce nom ou de cet uuid",
        ambiguousMacro: "cela désigne plus d’une macro",
        noMacroList: "les macros configurées dans ProPresenter n’ont pas pu être lues : aucune macro ne peut donc être mise sur une diapositive",
        unknownMacro: "aucune macro configurée n’a ce nom ou cet uuid",
        macroCollection: "la diapositive indique dans quelle collection se trouve sa macro, et la nouvelle macro n’est dans aucune collection",
        noGroupList: "les groupes configurés dans ProPresenter n’ont pas pu être lus : on ne peut donc pas savoir si le nouveau nom apporte une couleur ou un lien à un groupe configuré",
        ambiguousGroup: "deux groupes configurés portent ce nom",
        groupTie: "le groupe est lié à un groupe configuré, et le groupe configuré de ce nom n’a pas d’uuid auquel le lier",
        noIdentification: "la macro de la diapositive n’enregistre ni uuid ni nom à remplacer",
      },
    },
    mediaBin: {
      name: "Médias",
      tagline: "Comparer et analyser les listes de médias",

      baseline: "Référence",
      compare: "Comparer avec",
      baselineHint: "Déposez votre fichier Media ici, ou cliquez pour le choisir",
      compareHint:
        "Facultatif — déposez un second fichier Media pour voir les différences",
      baselineSuffix: "(référence)",
      pickFileHint:
        "Choisissez le fichier nommé « Media » dans le dossier Playlists de votre espace de travail ProPresenter.",

      startHeading: "Chargez un fichier de liste de médias pour commencer",
      whereIntro:
        "C'est le fichier nommé Media, sans extension, dans le dossier Playlists de votre espace de travail ProPresenter.",
      whereWindows: "Windows",
      whereMac: "macOS",
      whereLegacy: "ProPresenter 19 et antérieur, sur les deux plateformes",
      whereWorkspaceNote:
        "ProPresenter 20 a déplacé l'espace de travail hors de Documents. Le dossier indiqué par {placeholder} porte le nom de votre espace de travail — en général ProPresenter, sauf si vous l'avez renommé.",
      oneOrTwo:
        "Un fichier donne une analyse. Deux fichiers donnent une comparaison.",

      replace: "Remplacer",
      items: ["{n} élément", "{n} éléments"],
      playlists: ["{n} liste", "{n} listes"],
      appOn: "ProPresenter {version} · {platform}",

      diffDisabled: "Chargez un second fichier pour comparer",
      tabs: {
        diff: "Différences",
        audit: "Analyse",
        browse: "Parcourir",
        reorganise: "Réorganiser",
      },

      merge: {
        heading: "Reporter des modifications",
        intro:
          "Choisissez des modifications et appliquez-les à un côté, puis exportez-le. Le fichier chargé n'est jamais écrit : l'export produit une copie distincte.",
        direction: "Appliquer à",
        intoBaseline: "Référence ({filename})",
        intoCompare: "Comparaison ({filename})",
        selectAll: "Tout sélectionner",
        selectNone: "Tout désélectionner",
        selected: ["{n} modification sélectionnée", "{n} modifications sélectionnées"],
        applyAndExport: "Appliquer et exporter",
        blocked: [
          "{n} modification ne peut pas être appliquée",
          "{n} modifications ne peuvent pas être appliquées",
        ],
        blockedWhy: "Leur entrée est introuvable dans le fichier d'origine.",
        blockedDestructive:
          "Une liste recréée ne peut pas être reportée : cela supprimerait la liste de ce côté et tout son contenu.",
        blockedMoved:
          "Une liste déplacée dans un autre groupe ne peut pas encore être reportée : seul son nom pourrait l'être, et elle resterait à sa place.",
        willCreate: ["Crée {n} liste : {names}", "Crée {n} listes : {names}"],
        exportBlocked:
          "Ce côté ne peut pas être exporté : le réencodage perd du contenu que le schéma ne couvre pas.",
        exportedAs:
          "Exporté sous {filename}. Vérifiez-le dans ProPresenter avant de remplacer quoi que ce soit.",
        failed: "Ces modifications n'ont pas pu être appliquées ensemble : {reason}",
        nothingSelected: "Aucune sélection.",
      },

      reorganise: {
        heading: "Réorganiser",
        intro:
          "Les modifications sont rassemblées ici et appliquées seulement à l'export. Votre fichier d'origine n'est jamais écrit : l'export produit une copie distincte que vous mettez en place vous-même.",
        pending: ["{n} modification en attente", "{n} modifications en attente"],
        none: "Aucune modification pour l'instant.",
        undo: "Annuler la dernière",
        discard: "Tout abandonner",
        exportFile: "Exporter le fichier",
        exportBlocked:
          "Ce fichier ne peut pas être exporté : le réencodage perd du contenu que le schéma ne couvre pas.",
        exportedAs:
          "Exporté sous {filename}. Vérifiez-le dans ProPresenter avant de remplacer quoi que ce soit.",
        broken:
          "Ces modifications ne s'appliquent plus à ce fichier. Annulez la dernière ou abandonnez tout.",

        quickFixes: "Corrections rapides",
        quickFixesWhy:
          "Issues de l'analyse. Chacune met en file des modifications ordinaires, que vous pouvez relire et annuler ci-dessous.",
        removeDuplicates: ["Supprimer {n} doublon", "Supprimer {n} doublons"],
        removeDuplicatesWhy:
          "Conserve la première de chaque entrée répétée dans une même liste, avec des retouches identiques.",
        removeEmpty: ["Supprimer {n} liste vide", "Supprimer {n} listes vides"],
        removeEmptyWhy: "Listes ne contenant aucun média ni sous-liste.",
        showAffected: "Voir ce que cela change",
        affectedItem: "{name} — dans {playlist}",
        viewInAudit: "Voir dans l'analyse",
        keeping: "conserve {name}",
        differentName: "nom différent — vérifiez lequel garder",
        nothingToFix: "L'analyse n'a rien trouvé à corriger automatiquement.",

        rename: "Renommer",
        remove: "Supprimer",
        moveUp: "Monter",
        moveDown: "Descendre",
        moveTo: "Déplacer vers…",
        renameItemPrompt: "Nouveau nom pour cet élément",
        renamePlaylistPrompt: "Nouveau nom pour cette liste",
        removePlaylistConfirm:
          "Supprimer {name} et ses {n} éléments ? Vous pouvez encore annuler avant l'export.",
        emptyPlaylist: "vide",
      },
    },
  },

  rules: {
    tier: "niveau {n}",
    excepted: "exception",
    exceptedBecause: "exception\u202f: {reason}",
    separator: "\u202f; ",
    marker: "Marqueur de ligne {marker}",
    repeatMarker: ["Marqueur de répétition {marker}\u202f: chanté {n} fois", "Marqueur de répétition {marker}\u202f: chanté {n} fois"],
    groupName: "Le groupe {group} n'est pas dans la liste des groupes",
    groupNameSpacing: "Le groupe {group} ne diffère de {listed}, dans la liste, que par ses espaces",
    groupAfter: "{group} juste après {after}",
    firstGroup: "Commence par {actual}, pas par {expected}",
    firstGroupUnnamed: "Commence par une diapositive sans groupe, pas par {expected}",
    lastGroup: "Se termine par {actual}, pas par {expected}",
    lastGroupUnnamed: "Se termine par une diapositive sans groupe, pas par {expected}",
    repeatedGroup: "{group} ne dit pas la même chose qu'à sa première apparition, diapositive {slide}",
    macrosMissing: "Il manque {macros}",
    macrosExtra: "Inattendu ici\u202f: {macros}",
    macrosNone: "Aucune macro",
    macrosTooFew: ["Il faut au moins {n} macro", "Il faut au moins {n} macros"],
    macrosTooMany: ["Au plus {n} macro", "Au plus {n} macros"],
    macrosDisabled: "désactivées\u202f: {macros}",
    macroAlone: "{macro} avec {others}",
  },

  units: {
    bytes: "{n} o",
    kilobytes: "{n} ko",
    megabytes: "{n} Mo",
  },

  kinds: {
    video: "vidéo",
    image: "image",
    audio: "audio",
    live_video: "vidéo live",
    other: "autre",
  },
};
