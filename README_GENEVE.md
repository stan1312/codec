# Codec — version modifiée (enquête du 2 octobre 2025, Genève)

Version modifiée de [Codec (SITU Research)](https://github.com/SITU-Research/codec), sous licence AGPL-3.0. Elle ajoute trois choses :

1. **La lecture synchronisée** : un curseur global sur la timeline ; chaque vidéo ouverte se cale sur l'heure du curseur selon sa chronolocalisation.
2. **Des cônes de vue sur la carte** : direction et angle de champ de chaque caméra. Ils peuvent bouger avec la caméra si une trajectoire est fournie.
3. **Deux scripts** : `tools/prepare_media.py` (copies de lecture, hash, métadonnées) et `tools/colmap_track.py` (trajectoire d'une caméra calculée avec COLMAP et placée sur la carte).

Tout le reste de Codec (Google Sheet, Netlify, mode « fichiers locaux ») fonctionne comme avant. Voir le `README.md` d'origine pour l'installation.

---

## 1. Lecture synchronisée

**Utilisation**

- Barre de lecture au-dessus de la timeline : lecture/pause, ±10 s, ±1 s, ±0,1 s, vitesse (×0,1 à ×4), horloge.
- **Curseur rouge** : le faire glisser pour se déplacer dans le temps. Un double-clic sur une zone vide de la timeline y place le curseur.
- Clavier : `espace` = lecture/pause, `←/→` = ±1 s, `Maj+←/→` = ±0,1 s.
- Toutes les vidéos ouvertes affichent l'image correspondant à l'heure du curseur. Une vidéo qui n'a pas encore commencé, ou qui est terminée, est grisée.
- Les contrôles natifs d'une vidéo pilotent aussi l'horloge : déplacer une vidéo déplace toutes les autres.
- Le bouton **synchro / libre** en haut à droite de chaque vidéo la détache du curseur, par exemple pour la regarder seule.

**Précision.** Pendant la lecture, l'écart entre les vidéos reste sous 0,1 s : de petits écarts sont rattrapés en ajustant légèrement la vitesse, les gros par un saut. À l'arrêt, chaque vidéo est sur la bonne image. Mais l'affichage ne peut pas être plus juste que la colonne de chronolocalisation : la synchronisation fine se fait en amont, par l'audio (AudioAlign, ou la synchronisation multicaméra de DaVinci Resolve).

**Nouvelle colonne facultative.** `Sync offset (s)` : correction en secondes, décimales acceptées, ajoutée à la chronolocalisation, par exemple `0.4` ou `-1.25`. Elle décale aussi la barre sur la timeline. Pratique pour reporter le résultat d'une synchronisation audio sans réécrire l'heure. La chronolocalisation accepte aussi les décimales : `2025-10-02 20:47:12.4`.

**Limites**

- Ouvrir au maximum 4 à 6 vidéos en même temps. Au-delà, le navigateur peine à décoder et la synchronisation se dégrade.
- Les vidéos de téléphone sont souvent à **cadence variable** et se décalent peu à peu. Passer d'abord par `tools/prepare_media.py`, qui crée des copies à cadence fixe avec une image clé par seconde, pour des déplacements rapides et exacts.

## 2. Cônes de vue et trajectoires

**Nouvelles lignes dans l'onglet `Platform config`** (toutes facultatives) :

| Clé | Exemple |
| --- | --- |
| Title of column used for bearing | `Bearing (deg)` |
| Title of column used for field of view | `FOV (deg)` |
| Title of column used for sync offset | `Sync offset (s)` |
| Title of tab with trajectories | `trajectories` |
| Rank of trajectories row with column names | `1` |
| Cone length (m) | `40` |
| Default field of view (deg) | `60` |

**Colonnes de l'onglet media assets.** `Bearing (deg)` est la direction de la caméra sur la **première image** : 0 = nord, 90 = est, sens horaire. `FOV (deg)` est l'angle de champ horizontal : environ 65° pour un téléphone en paysage, 40° en portrait. La position (lat/lon) est celle de la première image, comme dans Codec.

**Onglet `trajectories`** (facultatif), une ligne par instant :

| UAR | t | lat | lon | bearing | quality |
| --- | --- | --- | --- | --- | --- |
| GE0210-0042 | 0.000 | 46.2086200 | 6.1488000 | 140.0 | colmap;anchors |

- `t` = secondes depuis le début de la vidéo.
- Sur la carte, le point et le cône de la vidéo suivent sa trajectoire à l'heure du curseur. Entre deux lignes, la position est interpolée.
- Sans trajectoire, le cône reste fixe, à la position et dans la direction de la première image.
- Cônes vifs = vidéo en cours à l'heure du curseur ; pâles = hors de sa plage horaire. Trajectoire en pointillés.

## 3. Scripts

Il faut Python 3 avec numpy, ffmpeg et, pour les trajectoires, [COLMAP](https://colmap.github.io/install.html) (`brew install colmap` sur Mac).

### `tools/prepare_media.py`

```bash
python3 tools/prepare_media.py originaux/ copies/
```

- Ne modifie jamais les originaux. Pour chacun, il calcule le SHA-256, enregistre les métadonnées ffprobe complètes (`copies/metadata/<UAR>.json`) et repère la cadence variable.
- Il produit `copies/<UAR>.mp4` : cadence fixe 30 i/s, 720p maximum, H.264, une image clé par seconde.
- Il produit aussi `copies/manifest.csv` : UAR, hash de l'original et de la copie, durée (à coller dans la colonne de durée), date de création et GPS s'ils ont survécu, appareil, cadence.
- Nommer les originaux par leur UAR avant de lancer le script, sans point dans le nom (`GE0210-0042.mov`).

### `tools/colmap_track.py`

```bash
python3 tools/colmap_track.py all copies/GE0210-0042.mp4 travail/0042 \
    --uar GE0210-0042 --lat 46.20851 --lon 6.14912 --bearing 205 \
    --anchor 38.5,46.20790,6.14870 --smooth 3 -o travail/0042/trajectoire.csv
```

Le script enchaîne trois étapes, qui peuvent aussi être lancées une par une : `frames`, `colmap` et `georef`.

1. `frames` extrait environ 3 images par seconde (`--fps`) en notant **l'horodatage exact** de chacune.
2. `colmap` lance COLMAP : extraction des points, appariement des images successives, reconstruction.
3. `georef` place la reconstruction sur la carte :
   - **position et direction de la première image**, lues dans le sheet : `--lat --lon --bearing` ;
   - **l'échelle**, au choix :
     - `--anchor t,lat,lon` (**recommandé**) : une deuxième position connue, par exemple un moment où la caméra passe devant un repère géolocalisé. Avec deux ancres ou plus, le script recalcule aussi l'orientation et affiche l'écart avec le cap du sheet, ce qui sert de contrôle.
     - `--scale` : mètres par unité COLMAP, si on la connaît ;
     - `--camera-height 1.5` : estimation à partir de la hauteur de la caméra au-dessus du sol, qui doit être visible. **Approximatif**, à signaler comme tel.
   - Le sol, quand il est visible, sert à corriger la verticale. Les téléphones penchent souvent vers le bas, ce qui fausserait les directions.

Le résultat est un CSV `UAR,t,lat,lon,bearing,quality` à coller dans l'onglet `trajectories`. La colonne `quality` indique la méthode utilisée pour l'échelle, les trous (`gap-before-…`) et les vues trop plongeantes, dont la direction n'est pas fiable.

**À savoir sur COLMAP** (c'est là que se trouvent les vraies limites) :

- COLMAP échoue souvent sur les images de nuit, enfumées par les gaz, floues ou qui bougent beaucoup. Il peut aussi couper une vidéo en plusieurs morceaux : le script prend le plus grand et le signale.
- Les images non reconstruites créent des trous, interpolés en ligne droite dans Codec.
- Une trajectoire doit **toujours** être vérifiée à l'œil contre la vidéo et des repères connus avant d'être utilisée comme élément de preuve.

## 4. Ajout automatique des vidéos et réglage du cône

### Mise en place (une seule fois)

1. Dans Netlify, *Site configuration → Environment variables* : ajoutez `CODEC_WRITE_KEY` avec un mot de passe de votre choix. Sans cette variable, Codec reste en lecture seule.
2. Dans le Google Sheet, *Partager* : donnez au compte de service (l'adresse de `GOOGLE_SERVICE_ACCOUNT_EMAIL`) le rôle **Éditeur**, et non plus Lecteur.
3. Facultatif : créez un onglet `trajectories`, avec `UAR` en A1 et `t` en B1.
4. Facultatif : dans `Platform config`, ajoutez la fenêtre de l'événement :

   | Clé | Exemple |
   | --- | --- |
   | Capture window start | `2026-06-14 14:00` |
   | Capture window end | `2026-06-15 10:00` |
   | Time zone | `Europe/Zurich` |

   Sans ces lignes, la fenêtre est celle de la timeline (`Timeline begin/end datetime`).

La première fois que vous enregistrez quelque chose depuis Codec, la clé est demandée, puis mémorisée dans ce navigateur.

### Ajouter des vidéos depuis la plateforme

- Chargez vos fichiers au démarrage, ou à tout moment avec le bouton **+ vidéos** de la barre du haut.
- Les fichiers qui n'ont pas encore de ligne dans le sheet s'affichent dans le panneau **Nouvelles vidéos**. Pour chacun, Codec lit les métadonnées directement dans le navigateur, sans rien envoyer : toutes les dates, la position GPS avec sa marge d'erreur, la durée, l'appareil.
- **Ajouter au sheet** crée les lignes : UAR, heure de captation, durée, position, angle de champ estimé, et des colonnes *(auto)* qui expliquent d'où vient la date et à quel point elle est fiable.
- Les lignes déjà présentes ne sont **jamais modifiées**.

### Comment l'heure de captation est choisie

Un fichier vidéo contient souvent plusieurs dates qui ne veulent pas dire la même chose. On ne prend donc **jamais simplement la plus récente**. Les sources sont classées par fiabilité :

| Fiabilité | Source | Signification |
| --- | --- | --- |
| 5 | « creationdate » Apple, avec fuseau horaire | Début de l'enregistrement |
| 3 | Nom de fichier d'appareil photo (`VID_20260614_191524`, `PXL_…` en UTC) | Début de l'enregistrement |
| 3 | Date `©day` | Début ou fin |
| 1–2 | Date du conteneur (mvhd) | Souvent la date d'export, d'AirDrop ou de montage. Sur vos vidéos de test, elle tombe le 15 ou le 16 juin. |
| 1 | WhatsApp, Signal, Telegram (nom du fichier) | Heure de **réception**. Ne sert que de limite : la vidéo a été filmée avant. |
| 0 | Date de modification du fichier | Copie ou synchronisation |

On retient la source la plus fiable **dont la vidéo entière tient dans la fenêtre de l'événement**.

- Si une source plus fiable tombe hors de la fenêtre (horloge du téléphone fausse ?), si deux sources sérieuses se contredisent de plus d'une minute, ou si aucune date n'est compatible, la ligne est marquée `conflit`, `hors fenêtre` ou `basse`, en rouge dans le panneau.
- Dans ces cas, l'heure n'est pas inventée : elle reste vide, à chronolocaliser à la main.

### Régler le cône sur la carte

Ouvrez une vidéo : un encadré **Cône** apparaît en haut à gauche de la carte.

- **direction** : cliquez sur la carte vers où regarde la caméra **à l'image affichée**. Si la vidéo a une trajectoire relative, Codec tient compte de la rotation mesurée à cet instant et recalcule le cap de départ.
- **position** : cliquez là où se trouve la caméra à l'image affichée. Utile pour corriger le GPS, qui a souvent une marge de 20 à 40 m.
- **angle − / +** : angle de champ, par pas de 5°.

Chaque réglage est **enregistré automatiquement** dans le sheet (colonnes `Bearing (deg)`, latitude/longitude, `FOV (deg)`), environ une demi-seconde après le dernier clic.

### En lot depuis le Mac : `tools/auto_ingest.mjs`

```bash
node tools/auto_ingest.mjs "…/03_CODEC/videos_test" --site https://votre-codec.netlify.app \
     --key VOTRE_CLE --proxies "…/03_CODEC/copies" --trajectory vggt \
     --vggt-repo ~/COPWATCH_3D/gvhmr/third-party/vggt --python <python de l'env gvhmr>
```

Il fait la même chose que le panneau, et en plus :

- il calcule le SHA-256 de chaque original ;
- il écrit un **rapport** `_codec_work/rapport_dates.csv` avec toutes les dates trouvées et celle retenue, pour garder la trace du raisonnement ;
- il fait les copies de lecture ;
- il calcule les **trajectoires** (`--trajectory colmap` ou `vggt`) et les écrit dans l'onglet `trajectories`.

Les trajectoires sont **relatives** (colonnes `x`, `y` en mètres, `heading_rel`). Codec les place sur la carte avec la position et le cap de la première image : régler la direction sur la carte fait tourner tout le trajet.

- `--dry-run` : tout lire sans rien écrire.
- `tools/vggt_poses.py` : VGGT, plus robuste que COLMAP sur les images difficiles. Il utilise la puce Apple (« mps ») si elle est disponible, et au maximum 48 images par vidéo par défaut.
- L'échelle des trajectoires relatives vient de la hauteur de la caméra : 1,5 m par défaut. C'est **approximatif**, à vérifier.

## 5. Tests

- `node --experimental-default-type=module --test tests/sync_geo.test.mjs` : logique de synchronisation et géométrie.
- `python3 tests/test_colmap_track.py` : géoréférencement sur une scène synthétique connue (marche de 52 m) :
  - erreur < 1 cm avec une échelle connue ou une deuxième ancre ;
  - < 10 cm avec l'estimation par la hauteur ;
  - un cap faux de 10° est corrigé par la deuxième ancre.
- `python3 tools/make_test_videos.py testdata/` génère des vidéos de test avec l'horloge incrustée.
- `node tests/harness/run.mjs` lance le test navigateur de la synchronisation avec de vraies balises `<video>`, avec un serveur statique sur le port 8765.
- `node --test tests/capture_time.test.mjs` : choix de l'heure de captation, y compris sur vos deux vraies vidéos d'iPhone si elles sont présentes.
- `node --test tests/sheet_write.test.cjs` : écriture dans le sheet, sur un faux sheet en mémoire.
- `testdata/sheet/*.csv` contient des onglets d'exemple à importer dans une copie du Google Sheet modèle, pour essayer avec les vidéos de test.
