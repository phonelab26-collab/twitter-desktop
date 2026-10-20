# Passation — Client X/Twitter Desktop (Electron + React, accès invité)

> Document de transfert destiné à un agent successeur.
> Dernière mise à jour : 2026-10-19.
> **État au 2026-10-20 : application fonctionnelle de bout en bout** (Electron + React, sans compte).
> Profil, derniers posts d'un compte, tendances par lieu, posts populaires, posts par sujet.
> `npm test` (111 tests sur fixtures réelles), `npm run typecheck`, `npm run build` passent ;
> l'app construite a été lancée et pilotée (captures réelles). Les §5.2, §6, §7 et §9 ci-dessous
> sont annotés avec ce qui a été résolu ; les limites restantes sont en §0.

## 0. Ce qui marche, d'où viennent les données, ce qui reste impossible sans compte

| Fonction | Source | Code |
|---|---|---|
| Profil | GraphQL `UserByScreenName` | `service.getProfile` |
| **Derniers posts d'un compte** | **page HTML `x.com/<handle>`** : le serveur y exécute `UserOriginalsTimeline` (404 sur l'API publique !) et embarque le résultat (§5.3) | `service.getUserTweets` + `ssr.ts` |
| Un tweet | GraphQL `TweetResultByRestId` | `service.getTweet` |
| **Noms de tendances par lieu** | **REST legacy `1.1/trends/place.json?id=<woeid>`** + `1.1/trends/available.json` (467 lieux) | `service.getTrends` / `getTrendLocations` + `trends.ts` |
| Posts populaires du jour | GraphQL `GlobalTrendingTimelineLoggedOut` | `service.getTrendingPosts` |
| Posts par sujet | GraphQL `GlobalTrendingSearchTimelineLoggedOut` (mot simple ; hashtag → vide) | `service.searchTopic` |

### 0.1 Onglet « Mon X » : le vrai x.com avec le compte de l'utilisateur (2026-10-20)

Choix de l'utilisateur : utiliser **son propre compte** comme sur Twitter. Retenu : afficher le vrai x.com
dans l'appli (onglet par défaut), plutôt qu'un client natif connecté (fragile, et plus risqué pour le compte).
- `src/main/xview.ts` : `WebContentsView` sur la fenêtre, session **`persist:x-account`** (la connexion
  survit aux redémarrages, isolée de l'UI). Pas de preload : x.com n'a **aucun accès** à l'IPC
  (`window.xapi` absent, vérifié) ; l'IPC refuse tout émetteur autre que l'UI (`isTrustedSender`).
- `src/main/xpolicy.ts` (testé) : la vue ne montre **que** des pages X (clics *et* redirections serveur ;
  sinon retour à l'accueil) ; popups in-app seulement pour `accounts.google.com` / `appleid.apple.com` / X,
  et seulement si la page qui ouvre est X ; autres liens → navigateur système (1/s max) ; user agent sans
  « Electron » (sinon Google refuse la connexion) ; permissions : notifications, presse-papier (écriture),
  plein écran, jugées sur l'origine demandeuse.
- L'utilisateur se connecte **lui-même** sur la page de X ; l'appli ne voit jamais le mot de passe.
  Bouton « Se déconnecter et effacer » = `clearStorageData` de la partition.
- `src/main/menu.ts` : menu Édition (copier/coller) ; outils de développement **absents** en build packagé
  (ils exposeraient le cookie de session).
- Les liens « Ouvrir dans Mon X » des vues invité ouvrent le post dans l'onglet.
- **Non vérifié** (nécessite le compte de l'utilisateur) : la connexion elle-même, en particulier
  « Continuer avec Google », que Google peut refuser dans une appli ; e-mail/nom d'utilisateur est la voie sûre.
- Risque assumé et signalé : les CGU de X ; l'onglet n'automatise rien (c'est x.com, piloté à la main).

### 0.2 Audit de sécurité complet (2026-10-20)

Rapport détaillé : [`docs/SECURITY-AUDIT.md`](SECURITY-AUDIT.md). En bref :
- **Session X** : en version installable, cookies chiffrés sur disque (fuse `enableCookieEncryption`,
  vérifié `v10`) ; avec `npm start`/`npm run dev`, la session X reste **en mémoire** (jamais sur disque)
  et le profil dev est séparé (`Twitter Desktop (dev)`).
- **Packaging** : `npm run package:dir` (signature ad hoc) produit `release/mac/Twitter Desktop.app`
  avec fuses durcis (RunAsNode, NODE_OPTIONS, --inspect désactivés ; intégrité asar ; asar seul).
  `npm run package` (dmg/zip signés) échoue tant que le trousseau contient **deux** certificats
  « Apple Development » identiques (`codesign` : *ambiguous*).
- Options de débogage/réseau refusées au lancement de la version installable ; une seule instance.

### 0.3 Qualité vérifiable (2026-10-20)

| Commande | Ce qu'elle prouve |
|---|---|
| `npm test` | 168 tests unitaires (fixtures réelles, sécurité IPC, garde-fous, budgets) |
| `npm run coverage` | couverture 90 % instructions / 84 % branches / 86 % fonctions / 94 % lignes ; échoue sous 80/75/80/80 |
| `npm run typecheck` | les trois projets TypeScript |
| `npm run e2e` | 12 étapes pilotant l'appli construite contre le vrai X (réseau requis) |
| `npm run package:dir` | version installable, fuses vérifiables avec `npx @electron/fuses read --app "release/mac/Twitter Desktop.app"` |

`main.ts`, `xview.ts`, `menu.ts` ne tournent que dans Electron : couverts par `npm run e2e`, exclus de
la couverture unitaire (voir `vitest.config.mts`). Tests à faire avec le compte de l'utilisateur :
[`docs/TEST-COMPTE.md`](TEST-COMPTE.md).

**Impossible sans compte (vérifié, pas une supposition) :**
- **Pagination** : la timeline de profil se termine par `TimelineTerminateTimeline` (`TopAndBottom`),
  les timelines tendance par un prompt « Log in ». Aucun cursor n'est jamais renvoyé.
  Un visiteur voit **~5 posts** par profil (épinglé compris) et 20 posts populaires.
- **Recherche plein texte** : `SearchByRawQuery` 404, `2/search/adaptive.json` 404,
  `1.1/search/tweets.json` 404 ; `x.com/search` et `x.com/explore` redirigent vers la connexion.
- **Réponses / médias d'un profil** : `x.com/<h>/with_replies` et `/media` ne contiennent aucune donnée.
- REST `1.1/statuses/user_timeline.json` 404, `1.1/users/show.json` 403.
- Les volumes de tweets des tendances (`tweet_volume`) sont toujours `null`.

**Quotas observés** : REST trends = **15 requêtes / 15 min** (cache 5 min dans `src/main/ipc.ts`),
GraphQL 150–500 selon l'op.

**Bonus non branché** : la page `x.com/<h>/status/<id>` embarque `TweetDetail` (`V14mpBzQZSbyXl_KTNYbJg`)
avec le fil de réponses — utilisable pour une vue « tweet + réponses » (`ssr.ts` sait déjà l'extraire).

---

## 1. Objectif

Construire un client X/Twitter **natif Electron + React** accédant aux API GraphQL **invité** (sans compte)
pour afficher : **Tendances**, **Profils**, **Tweets** d'un utilisateur, et la **Recherche par sujet**.

---

## 2. État actuel du projet

### 2.1 Arborescence

```
<racine du projet>/
├── docs/graphql-operations.tsv          # listing généré des opérations (20 Ko)
├── package.json, tsconfig*.json, vite.config.ts
├── dist-test/
├── src/
│   ├── main/api/
│   │   ├── client.ts        # client GraphQL (GET api.x.com/graphql/{relayId}/{Op})
│   │   ├── constants.ts     # bearer token, endpoints
│   │   ├── discovery.ts     # crawl des bundles x-web pour récupérer les relayId
│   │   ├── operations.ts    # registre OPERATIONS (relayId + args + flag guest)
│   │   ├── parsers.ts       # parseTimelineEntries, parseTweet, parseTrend, ...
│   │   └── service.ts       # XService : getProfile / getUserTweets / getTrends / ...
│   └── shared/types.ts      # Tweet, Trend, UserProfile, CursorPage, ...
└── node_modules/
```

> ⚠️ `src/main/api/service.ts` **est obsolète / faux** : il suppose que `UserTweets` renvoie
> directement les entrées (`parseTimelineEntries(data)`). **Ce n'est pas le cas** (voir §5).

### 2.2 Artefacts de recherche (hors projet, dans /tmp)

Le bac à sable de recherche est `/tmp/xtest/`. Il **disparaîtra** au redémarrage : copier ce qui compte.

| Fichier | Contenu |
|---|---|
| `/tmp/xtest/bundles/` | ~1800 fichiers JS `x-web` téléchargés depuis `abs.twimg.com/x-web/x-web/assets/` |
| `/tmp/xtest/entry-live.js` | bundle d'entrée live (`entry-client-logged-out-BSxMcrzD.js`) |
| `/tmp/xtest/opmap.json` | **Carte complète : 607 opérations** `{op, id, file, rootFields}` extraite des bundles |
| `/tmp/xtest/ops2.json` | variante de la même carte (inclut `relayId`, `args`, `text`) |
| `/tmp/xtest/opstatus.json` | statut HTTP testé pour chaque op |
| `/tmp/xtest/probe23.log` | **Résultat du scan massif** : quelles ops le serveur reconnaît réellement |
| `/tmp/xtest/gen-live.js` | chunk `generic-timeline-Did5-Qfz.js` (contient `genericTimelineQuery`) |
| `/tmp/xtest/create-urt-DsviGh_2.js` | moteur de rendu URT (280 Ko) — `fetchPage`, `timelineId` |
| `/tmp/xtest/cdp-events.json` | capture CDP Chrome headless (peu utile) |

Scripts utiles : `probe22.mjs` (variables UserTweets), `probe23.mjs` (scan statut ops), `probe24.mjs`, `probe25.mjs` (boucle 422 générique, §4.1).

---

## 3. Accès invité : ce qui fonctionne

### 3.1 Authentification (confirmé, stable)

```
1) POST https://api.x.com/1.1/guest/activate.json
   Header: Authorization: Bearer <TOKEN>
   → {"guest_token":"..."}

2) GET https://api.x.com/graphql/{relayId}/{OperationName}?variables={urlencoded JSON}
   Headers:
     Authorization: Bearer <TOKEN>
     x-guest-token: <guest_token>
     x-twitter-active-user: yes
     x-twitter-client-language: en
     User-Agent: <Chrome desktop UA>
     accept: application/json
```

Le bearer token est le token public du web client :
```
AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA
(urlencodé, décodé à l'usage)
```

**Hosts** : `api.x.com/graphql/...` et `x.com/i/api/graphql/...` fonctionnent **de manière identique**.
`api.twitter.com/graphql/...` répond aussi. `x.com/graphql/...` renvoie 401 (invalide).

### 3.2 Variables provider (obligatoires)

Chaque requête doit inclure ces flags, sinon le serveur renvoie `GRAPHQL_VALIDATION_FAILED / must be defined` :

```json
{
  "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider": false,
  "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider": false,
  "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider": false,
  "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider": false
}
```

> Le flag `appviewerisloggedin=false` est crucial : il demande la variante « déconnectée » du payload.

---

## 4. ⚠️ Découverte majeure : le serveur ne reconnaît qu'un sous-ensemble des opérations

Le scan exhaustif (`probe23.mjs`, 188 opérations candidates testées) montre que **la majorité des
opérations présentes dans les bundles JS renvoient HTTP 404 (corps vide)**, même avec des `relayId`
extraits du bundle live du même jour. Seules les opérations **déployées côté serveur** répondent.

**Règle d'interprétation du statut HTTP :**

| Statut | Signification |
|---|---|
| `200` | ✅ Opération reconnue **et** payload renvoyé |
| `422` + `GRAPHQL_VALIDATION_FAILED` | ⚠️ Opération **reconnue** mais variables manquantes/invalides → à corriger |
| `404` corps vide | ❌ Opération **non déployée** côté serveur. **Ne pas perdre de temps.** |
| `401` | mauvais host / token |

### 4.1 Liste blanche AVÉRÉE (200 ou 422) — c'est le périmètre réel

**Contrats validés en 200 le 2026-10-19** (boucle 422 `must be defined`, script
`docs/research/probe25.mjs`, ~600 ms entre requêtes). Variables = exactement celles
envoyées par `service.ts`, en plus des 4 flags §3.2. Réponses brutes dans
`src/main/api/__fixtures__/<op>.real.json`, utilisées par les tests.

| Opération | relayId | Variables requises (validées) | Root | Fixture(s) | Méthode |
|---|---|---|---|---|---|
| `UserByScreenName` | `nbvL57CsECD0Vmj_4CgeLA` | `screenName` | `user_result_by_screen_name.result` (User) | `.real.json` (elonmusk), `.not-found.real.json` → `{"data":{}}` | `getProfile` |
| `TweetResultByRestId` | `Qyd95xc1_Mp21pu1FeByNg` | `restId`, `withFocalTweet` (sans lui → 422) | `tweet_result_by_rest_id.result` (Tweet) | `.real.json` (id 20), `.not-found.real.json` → racine **sans** `result` | `getTweet` |
| `GlobalTrendingTimelineLoggedOut` | `65vLZc4n6GXaOs_GVYqU1g` | `count` (sans lui → 422) ; envoyé : `timeFilter:"Day"`, `count`, `cursor` | `global_trending_timeline_logged_out.timeline` | `.real.json` | `getTrendingPosts` |
| `GlobalTrendingSearchTimelineLoggedOut` | `5IgDecF7wG9lZ6djaIjNHg` | `count` ; envoyé : `tag`, `timeFilter:"Day"`, `count`, `cursor` | `global_trending_search_timeline_logged_out.timeline` | `.real.json` (tag `SpaceX`), `.unknown-tag.real.json` | `searchTopic` |
| `UserTweets` | `w5jr4AzUpoN8VpOQgrNjbw` | `screenName`, `count`, `cursor` | stage-1 seulement (§5) | `user-tweets-stage1.real.json` | `getUserTweets` (lève) |

Constats tirés des réponses réelles (ils corrigent des hypothèses antérieures) :
- **`GlobalTrendingTimelineLoggedOut` renvoie des POSTS tendance, pas des noms de tendance** :
  20 `TimelineTweet` + 1 `TimelineMessagePrompt` (« Log in to access all content »). Aucun
  `TimelineTrend`. Le bundle l'appelle « Popular Posts Today ». `getTrends(): Trend[]` (qui
  aurait renvoyé `[]` en silence) est remplacé par `getTrendingPosts(): CursorPage<Tweet>`, et
  `parseTrend`/`parseTimelineTrends` sont supprimés. Les noms de tags viennent de `GrokTags`
  (`fbdUMldqEPrFgd4gcYXLtg`), qui renvoie **404** en invité.
- `timeFilter` : le client web envoie `"Day"` ; une valeur inconnue → 422 `Internal server error`.
- `tag` filtre réellement (`SpaceX` ≠ `Technology`) ; un tag inconnu → 200 avec seulement le prompt de login.
- **Aucun cursor** dans les timelines invité : la page se termine par le prompt de login → `cursor: null`.
- Entrées : clé `entry_id` (snake_case), payload sous **`content.content`** (pas `content.item.content`).
- Tweets (schéma unifié) : `details.full_text` / `details.created_at_ms`, `counts.*`, `views.count`
  (string, `views: {}` possible), `media_entities2`, **`quoted_tweet_results`**, et **`note_tweet`**
  pour les posts longs (`details.full_text` est alors tronqué).
- Profil : bio dans `profile_bio.description`, lieu dans `location.location`, date dans
  `core.created_at_ms`, compteurs dans `relationship_counts` / `tweet_counts` ; pas de `media_count`.

Statuts du scan initial (probe23) pour le reste :

| Opération | relayId (snapshot) | Statut | Usage |
|---|---|---|---|
| `ArticleByTweetId` | | 422 | Article |
| `articleReaderModeByTweetIdQuery` | | 422 | Article |
| `tweetMediaViewerQuery` | | 422 | Médias d'un tweet |
| `userHoverCardBodyQuery` | | 422 | Carte hover |
| `AiTrendById` / `AiTrendByRestId` | | 422 | Tendance IA |
| `CommunityTweetsLoggedOutTimeline` | `84x3IT7wzlce9j_5bltLcA` | 422 | Communauté |
| `UserHighlightsTweets` | | 422 | Highlights |
| `unfollowUserMutation` / `listEditSlotDeleteMutation` / `professionalProfileModalCategoryDisplayMutation` | | 422 | mutations (hors scope invité) |

**Opérations testées qui renvoient 404 (NON utilisables, malgré leur présence dans les bundles) :**
`genericTimelineQuery`, `SearchByRawQuery`, `boostSearchQuery`, `postListQuery`, `explorePageQuery`,
`HomeTimelineQuery`, `UserVideoTimeline`, `UserPhotoTimeline`, `UserRepliesTimeline`,
`UserRepostsTimeline`, `UserOriginalsTimeline`, `followersQuery`, `followingQuery`,
`TweetDetail`, `tweetFavoritersQuery`, `tweetRetweetersQuery`, `hashtagTypeaheadQuery`, `listTweetsQuery`, etc.

> **Conséquence critique :** la stratégie « Recherche par sujet » via `SearchByRawQuery` est
> **bloquée** (404). Il faut trouver une alternative (voir §7).

---

## 5. ⚠️ Découverte majeure : les timelines utilisateur sont en DEUX TEMPS

C'est le point le plus important et le plus bloquant.

### 5.1 Stage 1 — `UserTweets` ne renvoie QU'UN ID

Requête validée (testée le 2026-10-19, HTTP 200) :

```
GET https://api.x.com/graphql/w5jr4AzUpoN8VpOQgrNjbw/UserTweets
    ?variables={"screenName":"elonmusk","count":20,"cursor":null,
                "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider":false,
                ...3 autres flags...}
```

Réponse (200, 209 octets) — **pas de tweets, juste un id** :

```json
{"data":{"user_result_by_screen_name":{
  "id":"VXNlclJlc3VsdHM6NDQxOTYzOTc=",
  "result":{
    "__typename":"User",
    "id":"VXNlcjo0NDE5NjM5Nw==",
    "profile_with_replies_timeline_v2":{"id":"VGltZWxpbmU6CgBeAAAAAAKiYi0A"}
  }}}}
```

- La variable s'appelle **`screenName`** (camelCase). `screen_name` → 422 `must be defined`.
- La root field est `user_result_by_screen_name` → `result.profile_with_replies_timeline_v2`.
- Le champ `__timeline_urt` (alias `timeline`) a des `args` `[count, cursor]`, mais le serveur
  n'en renvoie que l'`id` → **le contenu est chargé par une seconde requête**.

Le fragment Relay correspondant (dans `user-posts-all-087jI4D4.js`) :
```
profile_with_replies_timeline_v2 (Timeline) →
  timeline: __timeline_urt (TimelineTimeline) [args: count, cursor] →
    ...FragmentSpread `timeline`
```

### 5.2 Stage 2 — l'opération inconnue

Le mécanisme Relay utilise un **LinkedHandle** :
```
{alias:`timeline`, args:[cards_platform:"Web-12", count, cursor],
 filters:[], handle:`urt`, key:``, kind:`LinkedHandle`, name:`timeline`}
```
Le moteur URT (`create-urt-DsviGh_2.js`) appelle ensuite `fetchPage(timelineId, cursor)`.

La seule opération du bundle dont la **root field de `Query` est `timeline(id:...)`** est :

```
genericTimelineQuery
  relayId: KbQxo6b0b2vQt_SFf37zBA   (identique dans le bundle LIVE du 19/10)
  file:    generic-timeline-Did5-Qfz.js
  root:    Query.timeline(id: $timelineId) → TimelineTimeline [args: cards_platform:"Web-12", count, cursor]
  vars:    {timelineId, count, cursor}
```

**MAIS elle renvoie 404.** Testée exhaustivement :
- `api.x.com/graphql`, `x.com/i/api/graphql`, `api.twitter.com/graphql` → 404
- avec/sans `cursor`, avec/sans `count` → 404
- avec/sans `origin`/`referer`, avec/sans `x-csrf-token` → 404
- avec `&features={}` , `&featureSet=`, `&doc_id=` → 404
- le `relayId` **est bien à jour** (chunk live identique au chunk local, même hash, même id)

> ⚠️ La 404 persistante sur un id pourtant correct est un **signal contradictoire**.
> Hypothèses restantes :
> 1. L'op est déployée mais **restrictée** (nécessite un cookie de session web, pas seulement un guest token).
> 2. Une **autre** opération stage-2 existe dans un chunk que nous n'avons pas téléchargé
>    (le crawl live n'a récupéré que ~71 chunks référencés par l'entrée ; les lazy-chunks
>    comme `generic-timeline-Did5-Qfz.js` ne sont listés nulle part et doivent être devinés).
> 3. Le vrai stage-2 n'est pas une requête GraphQL mais un endpoint REST/Timeline legacy.

**→ C'est LA priorité n°1 du prochain agent.**

---

### 5.3 ✅ RÉSOLU (2026-10-20) — les posts d'un compte viennent de la page HTML

Le stage-2 GraphQL reste introuvable, mais il n'est plus nécessaire. En chargeant `x.com/<handle>`
sans compte (navigateur puis `curl` avec un UA Chrome), le serveur rend la page lui-même et y
embarque les réponses GraphQL complètes, sérialisées par seroval dans des `<script>` :

```
{kind:"GraphQLRequestStream.Completed",requestId:1,
 key:"dm5QEQ6Zg_QrdzrCDhMN6w{\"count\":20,\"cursor\":null,\"screenName\":\"elonmusk\",...}",
 result:$R[22]={kind:"Result.Ok",value:"{\"data\":{\"user_result_by_screen_name\":{...}}}"}}
```

- `dm5QEQ6Zg_QrdzrCDhMN6w` = **`UserOriginalsTimeline`** ; racine
  `user_result_by_screen_name.result.profile_user_originals_timeline.timeline` (timeline complète,
  `TimelinePinEntry` + `TimelineAddEntries` + `TimelineTerminateTimeline`). Le même id renvoie **404**
  sur `api.x.com` : seul le serveur web a le droit de l'exécuter pour un invité.
- Vérifié sur `elonmusk`, `jack`, `NASA` : 5 entrées. Handle inconnu → **HTTP 404** + `UserByScreenName` `{"data":{}}`.
- Extraction : `src/main/api/ssr.ts` (`extractSsrResults`), lance `BAD_RESPONSE` si la page est
  tronquée ou si un résultat n'est pas `Result.Ok`. Script d'étude : `docs/research/ssr-survey.mjs <chemins>`.
- Piège réel : une citation de citation porte un **stub** dans `quoted_tweet_results` (ids seuls) et
  le tweet complet dans **`nested_quoted_tweet_results`**.
- Fixtures : `profile-page.elonmusk.real.html`, `profile-page.not-found.real.html`.

## 6. Tendances : ENVELOPPE VALIDÉE ✅

> ✅ **Noms de tendances (2026-10-20)** : `GrokTags` est 404 et `x.com/explore` exige la connexion,
> mais le REST legacy **`GET api.x.com/1.1/trends/place.json?id=<woeid>`** répond en invité
> (bearer + `x-guest-token`) : `[{trends:[{name,url,query,tweet_volume:null,promoted_content}],as_of,created_at,locations}]`.
> Lieux : `1.1/trends/available.json` (Worldwide=1, France=23424819, Paris=615702…).
> woeid inconnu → 404 `{"errors":[{"code":34,...}]}`. Fixtures `trends-*.real.json`.

> ⚠️ **Corrigé le 2026-10-19 par une capture réelle (voir §4.1)** : la timeline ne contient
> que des `TimelineTweet` (pas de `TimelineTrend`), le payload est sous `content.content` et
> la clé d'entrée est `entry_id`. Le schéma ci-dessous était une hypothèse.

`GlobalTrendingTimelineLoggedOut` fonctionne en 200. Chemin des entrées :

```
data.global_trending_timeline_logged_out.timeline.instructions[]
  → content.entries[]
      → content.item            (tweet / tendance)
      → content.item.content    (__typename: TimelineTweet → tweet_results.result)
      → content.displayType     (TimelineTrend)
      → content.trend_metadata  (domain_context, url, ...)

instructions[] contient aussi des TimelineReplaceEntry / cursors.
```

L'ancien chemin `data.global_trending_timeline_logged_out.timeline.instructions[].entries[].content.item`
'est correct — **conserver `parsers.ts`'s `parseTrend` sur ce schéma**.

---

## 7. Recherche par sujet : BLOCKÉE — pistes alternatives

`SearchByRawQuery`, `boostSearchQuery`, `postListQuery`, `listsSearchQuery`, `hashtagTypeaheadQuery`,
`globalSearchTypeaheadQuery` → **tous 404**.

Pistes à explorer (par ordre de promesse) :

1. ✅ **RÉSOLU (2026-10-19)** — voir §4.1 : 200 avec `{tag, timeFilter:"Day", count, cursor}`.
   Ce n'est pas une recherche plein texte : ce sont les posts tendance d'un tag.
   **`GlobalTrendingSearchTimelineLoggedOut`** (`5IgDecF7wG9lZ6djaIjNHg`) — **422 = opération reconnue !**
   - Root field : `global_trending_search_timeline_logged_out` → `timeline`.
   - Variables candidates : `{rawQuery, count, cursor}`.
   - **C'est le candidat le plus sérieux pour « recherche par sujet ».**
2. **`AiTrendById` / `AiTrendByRestId`** (422) — renvoyerait les posts d'une tendance par id.
3. **`CommunityTweetsLoggedOutTimeline`** (422) — `community_results_by_rest_id` → `community_timeline` → `timeline`.
4. Re-crawler les bundles live pour une op `timeline`-root **non testée** dans `probe23`.
5. Endpoint REST legacy `/2/search/...` (peu probable, mais à éliminer).

**Prochaine action immédiate** : deviner les variables de `GlobalTrendingSearchTimelineLoggedOut`
exactement comme fait pour `UserTweets` (envoyer `{}`, lire le message 422 `must be defined`,
itérer jusqu'au 200).

---

## 8. Relay IDs : comment les redécouvrir (dynamique)

Les `relayId` sont **scope-déploiement** et tournent à chaque redéploy X. Ils doivent être
**rediscovernés dynamiquement**, jamais codés en dur seuls.

### 8.1 Algorithme de discovery (existant, à corriger)

1. `GET https://x.com/` → extraire l'URL du bundle d'entrée :
   `https://abs.twimg.com/x-web/x-web/entry-client-logged-out-*.js`
2. Télécharger ce bundle → extraire les ~71 références `assets/<name>-<hash>.js`
   (table dans `/tmp/xtest/entry-refs.json`).
3. Télécharger ces chunks + **deviner les lazy-chunks** (les chunks comme
   `generic-timeline-Did5-Qfz.js`, `user-posts-all-087jI4D4.js`, `user-videos-iRqRud8B.js`
   ne sont référencés par aucun manifest connu).
4. Regex pour extraire chaque opération :
   ```js
   /params:\{id:`([^`]+)`,metadata:\{\},name:`([A-Za-z0-9_]+)`/g
   ```
   → `(relayId, operationName)`.
5. Extraire la root field de `Query` en cherchant `kind:\`Operation\`,name:\`<Op>\`` puis
   les `concreteType:\`X\`,kind:\`LinkedField\`,name:\`Y\`` du segment.

> Note technique : les bundles utilisent des **backticks** comme séparateurs de chaînes après
> minification, pas des guillemets simples. La regex ci-dessus en tient compte.

### 8.2 Fichier de sortie attendu

Régénérer `docs/graphql-operations.tsv` + `src/main/api/operations.ts` à partir de `opmap.json`.
Le code de discovery existant (`discovery.ts`) doit être adapté pour produire le même format.

---

## 9. Ce qu'il reste à faire (plan ordonné)

- [x] **P0 — Stage-2 timeline.** Contourné : page HTML server-rendered (§5.3).
- [x] **P0 — Recherche par sujet.** `GlobalTrendingSearchTimelineLoggedOut` en 200 (§4.1).
- [x] **P1 — Valider l'enveloppe de recherche** et la sauvegarder comme fixture parser.
- [x] **P1 — Corriger `service.ts`** : `getUserTweets` lit la page de profil (§5.3).
- [ ] **P1 — Générer dynamiquement `operations.ts`** depuis la discovery, avec fallback snapshot
      + re-discovery automatique sur 404.
- [x] **P2 — IPC Electron sécurisé + preload.** `src/main/main.ts` (contextIsolation, sandbox,
      pas de Node, CSP, navigation et nouvelles fenêtres bloquées), `src/main/ipc.ts` (arguments
      revérifiés, liens externes limités à https x.com/twitter.com), `src/preload/preload.ts`,
      contrat `src/shared/ipc.ts`.
- [x] **P2 — Renderer React.** `src/renderer/` : Tendances (sujets par lieu + posts populaires),
      Profil, Sujet. Pas de scroll infini : aucun cursor pour un invité (§0).
- [x] **P3 — Tests.** 111 tests, fixtures réelles (§10).
- [ ] **Suite possible** : vue « tweet + réponses » via `TweetDetail` server-rendered (§0, bonus).
- [ ] **Durcissement restant (revue sécurité 2026-10-20, tous LOW, non faits)** :
      plafond de taille des corps de réponse (`web.ts`, `client.ts`, `discovery.ts`) ;
      fuses Electron au packaging (`runAsNode`, `nodeOptions`, `nodeCliInspect` off, `onlyLoadAppFromAsar`) ;
      n'accepter dans `getTrends` que les woeid de `trends/available` ; vérifier `event.senderFrame.url`
      dans `ipc.ts` ; `redirect: 'error'` aussi dans `client.ts` (fait dans `web.ts`).
- Corrigé après revue : `\x3C` de seroval décodé (`ssr.ts`), entités HTML de `full_text` décodées
  (pas celles de `note_tweet`, réelles), dates hors limites → inconnues, relay ids validés à la
  découverte, échec du guest token REST → `NETWORK_ERROR`, page sans données → `PAGE_UNAVAILABLE`
  (réessayable), navigation comparée par origine, permissions refusées, CSP dev pour le préambule Vite.

---

## 10. Fixtures de réponse (à collecter)

Sauvegarder en JSON réponses **200 réelles** pour :
- [x] `UserByScreenName` (elonmusk) + handle inconnu
- [x] Page de profil HTML (elonmusk) + page 404 (handle inconnu) — remplace `UserTweets` (fixture stage-1 supprimée)
- [x] REST `trends/place` (Worldwide), `trends/available`, woeid inconnu
- [x] `GlobalTrendingTimelineLoggedOut`
- [x] `GlobalTrendingSearchTimelineLoggedOut` (tag `SpaceX`) + tag inconnu
- [x] `TweetResultByRestId` (id 20) + id inconnu

Emplacement : `src/main/api/__fixtures__/` (chargées par `__tests__/fixtures.ts`).
Formes **jamais vues en réel** (tests encore synthétiques, à remplacer dès capture) :
cursors, `TweetWithVisibilityResults`, modules de conversation, réponses (`in_reply_to_*`),
dates legacy, utilisateur `UserUnavailable` (compte suspendu).

---

## 11. Pièges connus (à ne pas re-découvrir)

1. **404 ≠ variables manquantes.** 404 = op non déployée. 422 = op reconnue, variables fausses.
2. **`screenName`** en camelCase pour `UserTweets` (pas `screen_name`).
3. Les 4 flags `__relay_internal__pv__...` sont **toujours** obligatoires.
4. Les relayId changent à chaque redéploy X → **découverte dynamique obligatoire**.
5. Ne pas utiliser `x.com/graphql/` (401). Utiliser `api.x.com/graphql/` ou `x.com/i/api/graphql/`.
6. `genericTimelineQuery` **semble** être le bon stage-2 mais 404 malgré un id à jour —
   ne pas supposer qu'il est utilisable sans preuve d'un 200.
7. Le crawl live ne liste **pas** les lazy-chunks ; il faut les deviner ou les récupérer autrement.
8. Rate-limiting : prévoir ~350–700 ms entre requêtes (les probes les plus denses ont été
   throttées). Headers `x-rate-limit-*` présents dans les réponses.

---

## 12. Reprendre la recherche rapidement

```bash
# 1. Recréer le bac à sable
mkdir -p /tmp/xtest && cd /tmp/xtest

# 2. Voir les opérations reconnues par le serveur
grep -E '^(422|200)' /tmp/xtest/probe23.log

# 3. Tester une op 422 : deviner les variables en boucle
#    (modifier probe22.mjs avec l'op + relayId voulus, itérer sur le message 422)

# 4. Re-crawler les bundles live
node /tmp/xtest/live.cjs   # -> /tmp/xtest/live.json + live-files.json
```

Script de référence minimal pour une requête guest (à copier tel quel) :

```js
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BEARER = decodeURIComponent("AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA");
const gt = (await (await fetch("https://api.x.com/1.1/guest/activate.json",{
  method:"POST",headers:{authorization:`Bearer ${BEARER}`,"user-agent":UA}})).json()).guest_token;
const PV={};
for (const n of ["appviewerisloggedin","translationgroktranslatedpostenabled","tweetcomponentsgrokanalyzepost","translationnoteautotranslationenabled"])
  PV["__relay_internal__pv__xclientsfeatures"+n+"relayprovider"]=false;
const r = await fetch(`https://api.x.com/graphql/${relayId}/${opName}?variables=${encodeURIComponent(JSON.stringify({...PV,...vars}))}`,
  {headers:{authorization:`Bearer ${BEARER}`,"user-agent":UA,accept:"application/json","x-guest-token":gt}});
```

---

## 13. Artefacts critiques — COPIÉS ✅ (2026-10-19)

Tous les artefacts de recherche ont été copiés dans le projet :

> **Non publiés.** `docs/research/` est exclu du dépôt (`.gitignore`) : il contient des bundles
> JavaScript de X et une capture avec des cookies invités. Il n'existe que sur la machine de
> développement. Les tests de découverte utilisent de courts extraits dans
> `src/main/api/__fixtures__/x-web-*.excerpt.js`.

**`docs/research/`** (local uniquement) :

| Fichier | Contenu | Taille |
|---|---|---|
| `opmap.json` | 607 opérations `{op, id, file, rootFields}` | 119 Ko |
| `ops2.json` | idem + `relayId`, `args`, `text` | 182 Ko |
| `opstatus.json` | statut HTTP testé pour 188 opérations | 12 Ko |
| `probe23.log` | **scan massif : les 16 ops reconnues par le serveur** | 11 Ko |
| `probe22/23/24/25.mjs` | scripts de test à rejouer (`probe25` : boucle 422 générique, `node probe25.mjs <op> <relayId> <varsJSON> [out]`) | — |
| `live.cjs` | crawler live des bundles x-web | — |
| `entry-live.js` | bundle d'entrée live (`entry-client-logged-out-BSxMcrzD.js`) | 30 Ko |
| `entry-refs.json` | les 71 chunks référencés par l'entrée | 2 Ko |
| `gen-live.js` | chunk `generic-timeline-Did5-Qfz.js` (source de `genericTimelineQuery`) | 4 Ko |
| `create-urt-DsviGh_2.js` | moteur de rendu URT (280 Ko) — `fetchPage`, `timelineId` | 280 Ko |
| `cdp-events.json` | capture CDP Chrome headless (peu utile) | 49 Ko |
| `out-*.json` | réponses `UserTweets`/`UserPhotoTimeline`/`UserRepliesTimeline`/`UserRepostsTimeline`/`UserOriginalsTimeline` | — |

> **Les bundles complets (`/tmp/xtest/bundles/`, ~1800 fichiers, ~50 Mo) n'ont PAS été copiés**
> car volumineux et re-téléchargeables via `live.cjs`. Si le prochain agent en a besoin :
> `node docs/research/live.cjs` régénère `live.json` + `live-files.json`.
>
> Pour régénérer `opmap.json` sans re-crawler, voir §8 (regex sur les chunks).

### Commande de sauvegarde (historique)

```bash
mkdir -p docs/research   # depuis la racine du projet
cp -R /tmp/xtest/opmap.json /tmp/xtest/ops2.json /tmp/xtest/opstatus.json \
      /tmp/xtest/probe23.log /tmp/xtest/probe*.mjs /tmp/xtest/live.cjs \
      /tmp/xtest/entry-refs.json /tmp/xtest/entry-live.js \
      /tmp/xtest/gen-live.js /tmp/xtest/create-urt-DsviGh_2.js \
      /tmp/xtest/cdp-events.json /tmp/xtest/out-*.json \
      docs/research/
```
