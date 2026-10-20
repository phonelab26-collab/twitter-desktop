# Twitter Desktop

Un client de bureau macOS pour X (ex-Twitter), open source.

- **Mon X** : le vrai x.com, avec ton compte, dans une fenêtre d'application. Pastille sur l'icône du Dock et notification macOS quand tu as des notifications non lues.
- **Tendances**, **Profil**, **Sujet** : lisibles **sans compte**, via les accès invités de X.

> **Projet non officiel.** Sans lien avec X Corp. « X » et « Twitter » sont des marques de X Corp.
> Les onglets sans compte utilisent l'API interne (non documentée) du site web de X, ce qui va contre
> les conditions d'utilisation de X. X peut la changer ou la bloquer à tout moment. Utilise ce logiciel
> en connaissance de cause et à tes risques.

## Pourquoi lui faire confiance

Rien ici ne demande à être cru sur parole : tout se vérifie dans le code.

| Garantie | Où le vérifier |
|---|---|
| **Ton mot de passe n'est jamais vu par l'app.** Tu te connectes sur la page de connexion de X elle-même. | [`src/main/xview.ts`](src/main/xview.ts) |
| **x.com ne peut pas commander l'app.** La vue x.com n'a aucun pont vers l'app : sans preload, isolée, en bac à sable. Seule la page de l'app peut appeler le processus principal. | [`src/main/xview.ts`](src/main/xview.ts), [`src/main/main.ts`](src/main/main.ts) (`isTrustedSender`) |
| **Ta session est chiffrée sur le disque.** Dans l'app installée, les cookies sont chiffrés par le trousseau macOS. En développement, la session reste en mémoire. | `electronFuses` dans [`package.json`](package.json), [`src/main/xview.ts`](src/main/xview.ts) |
| **Aucune page piège déguisée en X.** La vue n'affiche que des pages X, y compris après une redirection. Les autres liens s'ouvrent dans ton navigateur. | [`src/main/xpolicy.ts`](src/main/xpolicy.ts) et ses tests |
| **L'app ne contacte que X.** `x.com`, `api.x.com` et les CDN `*.twimg.com`. Aucun serveur à nous, aucune télémétrie, aucune mise à jour automatique. | `git grep "fetch("` : 3 fichiers, tous dans [`src/main/api/`](src/main/api) ; CSP dans [`src/main/main.ts`](src/main/main.ts) |
| **Aucune dépendance à l'exécution.** Tout ce qui est dans `package.json` sert à construire ou à tester. React est intégré au build. | [`package.json`](package.json) |
| **Pas d'option de démarrage dangereuse.** Débogage à distance, proxy et certificats invalides sont refusés dans l'app installée. | [`src/main/guard.ts`](src/main/guard.ts) |
| **Le DMG correspond au code publié.** Il est construit par GitHub Actions à partir de ce dépôt, avec une empreinte SHA-256 et une attestation de provenance signée. | [`.github/workflows/release.yml`](.github/workflows/release.yml) |

Le détail, avec les limites connues, est dans [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md).

Ce que l'app ne contrôle pas : l'onglet « Mon X » **est** x.com. Ce que fait x.com (publicité, statistiques de X) s'y passe comme dans un navigateur.

## Installer (macOS)

1. Télécharge `Twitter Desktop-<version>-universal.dmg` dans les [Releases](../../releases). Il fonctionne sur les Mac Intel et Apple Silicon.
2. **Vérifie le fichier** (recommandé) :
   ```bash
   shasum -a 256 "Twitter Desktop-<version>-universal.dmg"   # compare avec SHA256SUMS.txt de la release
   gh attestation verify "Twitter Desktop-<version>-universal.dmg" --repo <propriétaire>/<dépôt>
   ```
   La seconde commande prouve que le fichier a été construit par la CI de ce dépôt, à partir d'un commit précis.
3. Ouvre le DMG et glisse l'app dans Applications.
4. **Premier lancement** : l'app n'est pas signée par Apple (cela coûte 99 $/an). macOS affiche « développeur non identifié ». Fais clic droit sur l'app, Ouvrir, puis Ouvrir. Si macOS dit que l'app est « endommagée » :
   ```bash
   xattr -cr "/Applications/Twitter Desktop.app"
   ```

## Construire depuis les sources

Node.js 24 ou plus récent.

```bash
npm ci
npm test            # tests unitaires, sur de vraies réponses de X enregistrées
npm run typecheck
npm start           # lance l'app
npm run package:mac # produit release/Twitter Desktop-<version>-universal.dmg (non signé)
```

`npm run e2e` lance l'app réelle et la pilote : il faut un écran et une connexion internet.

## Signaler une faille

Voir [SECURITY.md](SECURITY.md). Merci de ne pas ouvrir d'issue publique pour une faille.

## Licence

[MIT](LICENSE) © 2026 Achraf El Mabrouki
