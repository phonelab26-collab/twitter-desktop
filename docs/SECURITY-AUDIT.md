# Audit de sécurité — Twitter Desktop (2026-10-20)

Périmètre : tout `src/` (processus principal, vue x.com « Mon X », IPC, preload, interface React,
clients réseau et parseurs), la configuration de packaging, les dépendances.
Trois audits indépendants (isolation Electron et packaging ; réseau, parsing et dépendances ;
défaillances silencieuses), puis corrections, puis vérification en réel.

**Résultat : aucune faille critique. 2 points hauts, une quinzaine de moyens, corrigés ci-dessous.**
151 tests, typecheck et build passent ; l'application installable a été construite et lancée.

## Ce qui protège ton compte X

| Risque | Protection | Vérifié |
|---|---|---|
| Vol du cookie de session sur le disque (prise de compte sans mot de passe ni 2FA) | Version installable : cookies **chiffrés** par le trousseau macOS (fuse `enableCookieEncryption`). `npm start` / `npm run dev` : session X **en mémoire uniquement**, jamais écrite | Base de cookies inspectée : valeur en clair vide, chiffrée `v10` ; aucun dossier de session en dev |
| Lancer l'appli avec `--remote-debugging-port`, `--proxy-server`, `--ignore-certificate-errors`… pour lire la session | Options refusées au démarrage de la version installable (`src/main/guard.ts`) | Port de débogage resté fermé, processus arrêté |
| Utiliser le binaire comme interpréteur Node (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) | Fuses désactivés | `@electron/fuses read` |
| Modifier le code de l'appli installée | Intégrité de l'archive `app.asar` + chargement depuis l'asar seulement | Fuses activés (force limitée par une signature ad hoc, voir plus bas) |
| x.com commandant l'appli | Vue x.com sans preload, isolée, bac à sable ; l'IPC n'accepte que le cadre principal de la page de l'appli | `window.xapi` absent dans x.com |
| Page piégée affichée comme si c'était X | La vue n'affiche que des pages X, y compris après redirection serveur ; fenêtres de connexion limitées à `accounts.google.com`, `appleid.apple.com` et X, ouvertes seulement par X | Tests `xpolicy` |
| Outils de développement (montrent le cookie) | Absents de la version installable (menu, raccourcis, ouverture forcée) | — |
| Déconnexion illusoire | « Se déconnecter » propose d'abord la page de déconnexion de X (ferme la session chez X), puis l'effacement local | — |
| Deux instances sur le même profil | Verrou d'instance unique | — |

## Corrections réseau et données (processus principal)

- **Taille des réponses bornée** en flux (une bombe gzip de 200 Ko pouvait occuper 700 Mo de RAM) :
  `src/main/api/body.ts`, appliqué à toutes les requêtes.
- **Redirections** : refusées quand la requête porte un jeton ; suivies seulement vers x.com /
  abs.twimg.com pour les pages et les bundles.
- **Expressions régulières** sur du code distant bornées (blocage du processus principal mesuré à 3,5 s pour 160 Ko).
- **Quotas** : 4 requêtes GraphQL simultanées maximum, réservation du quota avant envoi, pas de
  renvoi en boucle quand X bloque pour 15 min ; tendances limitées aux lieux réels et à 10 appels / 15 min.
- **URLs de médias et d'avatars** acceptées seulement sur `pbs.twimg.com`, `video.twimg.com`, `abs.twimg.com`.
- **Messages d'erreur** venus de X tronqués ; cause réseau réelle (DNS, TLS, refus) conservée.
- **Pollution de prototype** du registre d'opérations impossible ; ids et chemins de bundles validés.

## Honnêteté des données (zéro donnée inventée, aucune erreur muette)

- Un champ X renommé (`entries`, `result`…) donne une **erreur explicite**, plus une liste vide ou un « compte introuvable ».
- « Certifié », « protégé », « réponse », « repost », « modifié » : **inconnu** quand X ne le dit pas, jamais « non ».
- Médias non affichables comptés et signalés sur la carte du post.
- Pages sans données : « réessaie plus tard » seulement si la page est normale ; sinon « format changé ».
- Échecs de chargement de x.com, plantages de page et échecs de démarrage montrés à l'utilisateur ;
  erreurs IPC journalisées côté principal (jamais les arguments).

## Dépendances

`npm audit --omit=dev` : **0 vulnérabilité**. Les 8 alertes « moderate » de `npm audit` viennent de
`sprintf-js` via `electron-builder`, outil de construction **non embarqué** ; ne pas appliquer
`npm audit fix --force` (rétrograde electron-builder). React est désormais en dépendance de dev
(il est déjà inclus dans le bundle Vite) : l'archive installée ne contient que le code compilé (456 Ko).

## Ce qui reste (décisions ou limites)

1. **Ancien profil en clair** : si tu t'es connecté avec `npm start` **avant** ces corrections, ta session
   X est peut-être encore en clair dans `~/Library/Application Support/Electron/Partitions/x-account/`.
   À supprimer, et par précaution déconnecte les autres sessions dans X (Paramètres → Sécurité → Sessions).
2. **Signature** : la version locale est signée « ad hoc ». Pour distribuer l'appli, il faut un certificat
   *Developer ID* et la notarisation Apple ; l'intégrité de l'asar ne vaut que ce que vaut la signature.
   `npm run package` échoue aujourd'hui car le trousseau contient deux certificats « Apple Development » identiques.
3. **Non testé avec ton compte** : la connexion elle-même, en particulier Google/Apple (Google peut refuser
   les applis intégrées ; e-mail/nom d'utilisateur est la voie sûre).
4. **Petits points non faits** (faible impact) : annulation des requêtes en cours à la fermeture de la fenêtre,
   délai maximal côté interface, indication visuelle quand un lien externe est ignoré par la limite de 1/s.
5. **`docs/research/`** (bundles JavaScript copiés depuis X, cookies invités anonymes dans `cdp-events.json`)
   est **exclu du dépôt public** et purgé de l'historique git ; il reste seulement sur la machine de développement.
   Les tests utilisent de courts extraits (`src/main/api/__fixtures__/x-web-*.excerpt.js`).
6. **CGU de X** : un client non officiel reste contraire aux conditions de X ; l'onglet « Mon X » n'automatise rien.

## Lien agent (2026-10-22)

Accès local, en lecture seule, au fil capturé dans « Mon X » (`src/main/agent/`). Revue de conception
par un agent *planner* avant le code, puis revues de code et de sécurité indépendantes : aucun point
critique ; les points hauts et moyens (ci-dessous) sont corrigés et couverts par des tests.

| Risque | Protection | Vérifié |
|---|---|---|
| Un programme local lit le fil sans y être autorisé | Coupé par défaut ; activation confirmée dans une fenêtre du processus principal ; jeton de 256 bits exigé à chaque requête, comparé en temps constant | Tests `server`, `link` ; e2e étape 14 (401 sans le bon jeton) |
| Une page web (CSRF, *DNS rebinding*) atteint le serveur | Écoute sur `127.0.0.1` seulement ; en-tête `Host` imposé ; toute requête portant `Origin` refusée ; aucun en-tête CORS | Tests `server` |
| Fuite du jeton | Jamais envoyé à l'interface (copié par le processus principal, masqué à l'écran) ; effacé du presse-papier après 1 min et à la fermeture de l'app ; chiffré sur disque par le trousseau, ou gardé en mémoire seulement ; jamais journalisé ; renouvelé si le port est déjà pris ; commande Claude Code en portée `local` (un seul dossier) | Tests `settings`, `link`, `ipc` |
| Le débogueur (nécessaire pour lire le trafic de x.com) détourné pour agir sur le compte | Liste fermée de commandes (`Network.enable`, `Network.disable`, `Network.getResponseBody`) appliquée deux fois : autour du débogueur d'Electron (`restrictDebugger`) et dans la capture. Ni script, ni clic, ni cookies ; les événements portant les en-têtes bruts sont ignorés | Tests `cdpTap` |
| Vie privée | Listes blanches : seules les opérations GraphQL de fils connus (par nom exact, sans `genericTimelineQuery` qui pagine n'importe quel fil) et les pages `/home`, `/search`, `/<compte>`, `/<compte>/status/<id>` sont lues ; signets, j'aime, notifications, messages jamais lus ; un post n'est servi que si X dit que son auteur (et celui qu'il cite) est public ; publicités exclues par défaut ; rien sur le disque ; vidé au changement de compte (cookie `twid`) et à la déconnexion | Tests `capture`, `feedStore`, `account` |
| Injection d'instructions par un post | Outils en lecture seule ; caractères invisibles (balises Unicode, contrôles bidi, espaces de largeur nulle) retirés des textes ; avertissement dans chaque réponse portant des posts, dans la description des outils et dans les `instructions` MCP ; conseil affiché de ne pas donner à cet agent un terminal ni un compte de courtage | Tests `feedStore` (texte piégé) |
| Quotas invités de X épuisés par un agent | Budgets propres à l'agent (60 appels / 15 min ; tendances 4 / 15 min, l'interface en gardant 10 sous la limite de 15 de X) et caches | Tests `guest` |
| Gel de l'interface par du trafic ou une requête hostile | Corps HTTP plafonné à 64 Ko ; délais d'en-têtes, de requête et d'inactivité (10 s) ; 16 connexions ; parcours JSON borné ; 8 corps lus à la fois ; 50 noms d'opération comptés au plus ; une lecture qui échoue est comptée, jamais perdue | Tests `server`, `capture`, `cdpTap` |

Limites connues : la forme des réponses du fil connecté n'a pas pu être vérifiée (pas de compte de test) ;
l'onglet Agent affiche les fils non reconnus et les entrées illisibles, c'est là qu'un écart se verra.
Le jeton figure en clair dans `~/.claude.json` et l'historique du terminal une fois la commande lancée.

## Lancer

```bash
npm run package:dir
```

puis ouvrir `release/mac/Twitter Desktop.app` (au premier lancement, macOS demande l'accès au trousseau
« Twitter Desktop Safe Storage » : c'est la clé de chiffrement des cookies). Pour le développement :
`npm start` (session X non conservée entre deux lancements, par sécurité).
