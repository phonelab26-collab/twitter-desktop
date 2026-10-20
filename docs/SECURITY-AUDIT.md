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

## Lancer

```bash
npm run package:dir
```

puis ouvrir `release/mac/Twitter Desktop.app` (au premier lancement, macOS demande l'accès au trousseau
« Twitter Desktop Safe Storage » : c'est la clé de chiffrement des cookies). Pour le développement :
`npm start` (session X non conservée entre deux lancements, par sécurité).
