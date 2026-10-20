# Politique de sécurité

## Signaler une faille

**N'ouvre pas d'issue publique.** Utilise le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability**.
Tu peux aussi écrire à spliffkilla11@gmail.com.

Indique la version (ou le commit), les étapes pour reproduire et l'impact (par exemple : accès à la session X, exécution de code, fuite de données).

Je réponds sous 7 jours. Une faille confirmée est corrigée dans une nouvelle release, et son auteur est remercié dans les notes de version s'il le souhaite.

## Ce qui est dans le périmètre

- L'application (processus principal, preload, interface) et le DMG publié dans les Releases.
- En priorité : tout ce qui pourrait exposer la session X de l'utilisateur, permettre à une page web de commander l'app, ou faire afficher une page non-X comme si c'était X.

## Hors périmètre

- Le site x.com lui-même et l'API de X : signale-les à X.
- Les avertissements de macOS liés à l'absence de signature Apple (limite connue, voir le README).

## Versions suivies

Seule la dernière release reçoit des correctifs.

L'audit le plus récent et ses limites connues sont dans [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).
