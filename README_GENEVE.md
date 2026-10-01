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

## 4. Tests

- `node --experimental-default-type=module --test tests/sync_geo.test.mjs` : logique de synchronisation et géométrie.
- `python3 tests/test_colmap_track.py` : géoréférencement sur une scène synthétique connue (marche de 52 m) :
  - erreur < 1 cm avec une échelle connue ou une deuxième ancre ;
  - < 10 cm avec l'estimation par la hauteur ;
  - un cap faux de 10° est corrigé par la deuxième ancre.
- `python3 tools/make_test_videos.py testdata/` génère des vidéos de test avec l'horloge incrustée.
- `node tests/harness/run.mjs` lance le test navigateur de la synchronisation avec de vraies balises `<video>`, avec un serveur statique sur le port 8765.
- `testdata/sheet/*.csv` contient des onglets d'exemple à importer dans une copie du Google Sheet modèle, pour essayer avec les vidéos de test.
