# Test avec ton compte X — liste de contrôle

Ces tests demandent ton compte : personne d'autre ne peut les faire. Utilise la **version installable**
(`npm run package:dir`, puis `release/mac/Twitter Desktop.app`). Coche chaque ligne ; si une ligne échoue,
note ce que tu vois (message exact, capture d'écran) : c'est ce qui me permet de corriger.

## 1. Connexion

- [ ] Au premier lancement, macOS demande l'accès au trousseau « Twitter Desktop Safe Storage » → **Toujours autoriser**.
- [ ] L'onglet « Mon X » affiche la page de connexion de X (compter ~10 s la première fois).
- [ ] Connexion par **e-mail / nom d'utilisateur + mot de passe** → ton fil d'accueil s'affiche.
- [ ] Si tu as la double authentification : le code est demandé et accepté.
- [ ] (Facultatif) « Continuer avec Google » / « Apple » : une petite fenêtre s'ouvre ; si Google refuse
      (« navigateur non sécurisé »), c'est une limite de Google : utilise l'e-mail.
- [ ] Quitter l'appli (⌘Q), la relancer → **tu es toujours connecté**.

## 2. Utilisation normale

- [ ] Faire défiler le fil d'accueil (chargement continu).
- [ ] Liker, reposter, répondre à un post.
- [ ] Écrire un post, avec une image (le sélecteur de fichiers s'ouvre).
- [ ] Ouvrir les notifications, puis les messages privés.
- [ ] Ouvrir un lien externe dans un post → il s'ouvre dans **ton navigateur habituel**, pas dans l'appli.
- [ ] Copier / coller du texte dans un post (⌘C / ⌘V).
- [ ] Vidéo : lecture, son, plein écran.

## 3. Navigation entre onglets

- [ ] ⌘1 Mon X, ⌘2 Tendances, ⌘3 Profil, ⌘4 Sujet (marche aussi pendant que tu es sur x.com).
- [ ] Depuis Tendances → « Posts populaires du jour » → « Ouvrir dans Mon X » : le post s'ouvre **connecté**.
- [ ] Revenir sur « Mon X » : tu retrouves la page où tu étais.
- [ ] Redimensionner la fenêtre : x.com suit la taille.

## 4. Déconnexion

- [ ] Bouton « Se déconnecter » → une fenêtre propose « Ouvrir la déconnexion de X » : la choisir,
      confirmer sur la page de X.
- [ ] Puis « Se déconnecter » → « Effacer les données locales » : la page de connexion revient.
- [ ] Relancer l'appli : tu n'es **plus** connecté.

## 5. Ce qui ne doit jamais arriver

- Une page qui n'est pas x.com affichée dans l'onglet « Mon X ».
- Une fenêtre qui s'ouvre toute seule.
- Un écran blanc sans message.
- Une demande de mot de passe ailleurs que sur la page de connexion de X.

Si l'un de ces cas se produit : ferme l'appli, ne te reconnecte pas, et signale-le.
