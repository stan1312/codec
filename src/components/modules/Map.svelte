<script>
  import { Map, Marker, controls } from "@beyonk/svelte-mapbox";
  import { throttle } from "underscore";
  import { watchResize } from "svelte-watch-resize";
  import {
    platform_config_store,
    media_store_filtered,
    ui_store,
    playback_store,
    trajectories_store,
    local_overrides,
    sheet_refresh,
  } from "../../stores/store";
  import { conePolygon } from "../../lib/geo";
  import { computePoses, pathOf, originOf, bearingFromClick, positionFromClick } from "../../lib/poses";
  import { cfgGet } from "../../lib/columns";
  import { sheetWrite } from "../../lib/sheetClient";
  const { NavigationControl, ScaleControl } = controls;

  let zoom, mapComponent;

  let handleResize = throttle(() => {
    if (mapComponent) mapComponent.resize();
  }, 500);

  // ---- view cones & camera trajectories ----
  let mapObj = null;
  let layers_ready = false;
  let update_scheduled = false;

  const cfg_num = (key, fallback) => {
    const v = parseFloat(String($platform_config_store[key] ?? "").replace(",", "."));
    return Number.isFinite(v) ? v : fallback;
  };

  $: poses = computePoses($media_store_filtered, $trajectories_store, $playback_store.time, $local_overrides);

  function build_features() {
    const length = cfg_num("Cone length (m)", 40);
    const default_fov = cfg_num("Default field of view (deg)", 60);
    const cones = [];
    const paths = [];
    for (const [UAR, pose] of Object.entries(poses)) {
      const medium = $media_store_filtered[UAR];
      const selected =
        UAR === edit_uar || $ui_store.media_in_view.includes(UAR) || $ui_store.media_hovered.includes(UAR);
      if (Number.isFinite(pose.bearing)) {
        const fov = Number.isFinite(pose.fov) ? pose.fov : default_fov;
        cones.push({
          type: "Feature",
          properties: { UAR, active: pose.active, selected },
          geometry: { type: "Polygon", coordinates: [conePolygon(pose.lat, pose.lon, pose.bearing, fov, length)] },
        });
      }
      const coords = medium && pathOf(medium, $trajectories_store[UAR], $local_overrides[UAR]);
      if (coords) {
        paths.push({
          type: "Feature",
          properties: { UAR, active: pose.active, selected },
          geometry: { type: "LineString", coordinates: coords },
        });
      }
    }
    return {
      cones: { type: "FeatureCollection", features: cones },
      paths: { type: "FeatureCollection", features: paths },
    };
  }

  function setup_layers() {
    if (!mapObj || layers_ready) return;
    const empty = { type: "FeatureCollection", features: [] };
    mapObj.addSource("codec-paths", { type: "geojson", data: empty });
    mapObj.addSource("codec-cones", { type: "geojson", data: empty });
    mapObj.addLayer({
      id: "codec-paths",
      type: "line",
      source: "codec-paths",
      paint: {
        "line-color": "#d90c1e",
        "line-width": ["case", ["get", "selected"], 3, 1.5],
        "line-opacity": ["case", ["get", "selected"], 0.9, 0.35],
        "line-dasharray": [2, 1],
      },
    });
    mapObj.addLayer({
      id: "codec-cones-fill",
      type: "fill",
      source: "codec-cones",
      paint: {
        "fill-color": "#d90c1e",
        "fill-opacity": [
          "case",
          ["all", ["get", "active"], ["get", "selected"]], 0.4,
          ["get", "active"], 0.22,
          0.05,
        ],
      },
    });
    mapObj.addLayer({
      id: "codec-cones-line",
      type: "line",
      source: "codec-cones",
      paint: {
        "line-color": "#d90c1e",
        "line-width": ["case", ["get", "selected"], 2, 1],
        "line-opacity": ["case", ["get", "active"], 0.9, 0.25],
      },
    });
    layers_ready = true;
    schedule_update();
  }

  function on_map_ready() {
    mapObj = mapComponent.getMap();
    mapObj.on("click", on_map_click);
    if (mapObj.isStyleLoaded()) setup_layers();
    else mapObj.once("load", setup_layers);
  }

  function schedule_update() {
    if (update_scheduled || !layers_ready) return;
    update_scheduled = true;
    requestAnimationFrame(() => {
      update_scheduled = false;
      const { cones, paths } = build_features();
      mapObj.getSource("codec-cones")?.setData(cones);
      mapObj.getSource("codec-paths")?.setData(paths);
    });
  }

  $: poses, $ui_store, $local_overrides, edit_uar, layers_ready, schedule_update();

  // ---- editing the cone of a video (saved to the sheet automatically) ----
  let edit_mode = null; // null | "direction" | "position"
  let save_state = ""; // "", "…", "enregistré", "erreur: ..."
  let save_timer = null;
  let pending = {}; // UAR -> {column: value}

  // the video being edited: the last one opened that has a position
  $: edit_uar = [...$ui_store.media_in_view].reverse().find((u) => poses[u]) || null;
  $: edit_medium = edit_uar ? $media_store_filtered[edit_uar] : null;
  $: edit_origin = edit_medium ? originOf(edit_medium, $local_overrides[edit_uar]) : null;
  $: if (!edit_uar) edit_mode = null;
  $: if (mapObj) mapObj.getCanvas().style.cursor = edit_mode ? "crosshair" : "";

  function set_override(uar, values) {
    $local_overrides[uar] = { ...($local_overrides[uar] || {}), ...values };
  }

  function queue_save(uar, columns) {
    pending[uar] = { ...(pending[uar] || {}), ...columns };
    save_state = "…";
    clearTimeout(save_timer);
    save_timer = setTimeout(flush_saves, 600);
  }

  async function flush_saves() {
    const jobs = Object.entries(pending);
    pending = {};
    try {
      for (const [uar, values] of jobs) await sheetWrite({ action: "update_media", uar, values });
      save_state = "enregistré dans le sheet";
      $sheet_refresh += 1;
    } catch (e) {
      save_state = "erreur : " + e.message;
    }
  }

  // drop local edits once the sheet shows the same values
  $: {
    let changed = false;
    for (const [uar, o] of Object.entries($local_overrides)) {
      const m = $media_store_filtered[uar];
      if (!m || Object.keys(pending).includes(uar)) continue;
      const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
      const done = Object.entries(o).every(([k, v]) => same(m[k], v));
      if (done) {
        delete $local_overrides[uar];
        changed = true;
      }
    }
    if (changed) $local_overrides = $local_overrides;
  }

  function on_map_click(e) {
    if (!edit_mode || !edit_medium) return;
    const click = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    const track = $trajectories_store[edit_uar];
    const ov = $local_overrides[edit_uar];
    const C = (k) => cfgGet($platform_config_store, k);
    if (edit_mode === "direction") {
      const b = bearingFromClick(edit_medium, track, $playback_store.time, click, ov);
      if (!Number.isFinite(b)) return;
      set_override(edit_uar, { bearing: b });
      queue_save(edit_uar, { [C("Title of column used for bearing")]: b });
    } else if (edit_mode === "position") {
      const p = positionFromClick(edit_medium, track, $playback_store.time, click, ov);
      set_override(edit_uar, p);
      queue_save(edit_uar, {
        [C("Title of column used for latitude")]: p.lat,
        [C("Title of column used for longitude")]: p.long,
      });
    }
  }

  function change_fov(delta) {
    if (!edit_medium) return;
    const def = cfg_num("Default field of view (deg)", 60);
    const cur = Number.isFinite(edit_origin?.fov) ? edit_origin.fov : def;
    const fov = Math.min(170, Math.max(5, cur + delta));
    set_override(edit_uar, { fov });
    queue_save(edit_uar, { [cfgGet($platform_config_store, "Title of column used for field of view")]: fov });
  }

  function onMarkerClick(event) {
    let UAR = event.target.dataset.uar; //automatically lowercased
    if ($ui_store.media_in_view.includes(UAR)) {
      $ui_store.media_in_view = $ui_store.media_in_view.filter(
        (exist_UAR) => exist_UAR !== UAR,
      );
    } else {
      $ui_store.media_in_view = [...$ui_store.media_in_view, UAR];
    }
  }
  function onMarkerOver(event) {
    let UAR = event.target.dataset.uar; //automatically lowercased
    $ui_store.media_hovered = [...$ui_store.media_hovered, UAR];
  }
  function onMarkerOut(event) {
    let UAR = event.target.dataset.uar; //automatically lowercased
    $ui_store.media_hovered = $ui_store.media_hovered.filter(
      (exist_UAR) => exist_UAR !== UAR,
    );
  }
</script>

<!-- svelte-ignore missing-declaration -->
<span class="map_container" use:watchResize={handleResize}>
  {#if edit_uar}
    <div class="cone_editor" on:pointerdown|stopPropagation>
      <div class="ce_title">Cône : <b>{edit_uar}</b></div>
      <div class="ce_row">
        <button class:on={edit_mode === "direction"} on:click={() => (edit_mode = edit_mode === "direction" ? null : "direction")}>
          direction
        </button>
        <button class:on={edit_mode === "position"} on:click={() => (edit_mode = edit_mode === "position" ? null : "position")}>
          position
        </button>
        <span class="ce_sep" />
        angle
        <button on:click={() => change_fov(-5)}>−</button>
        <span class="ce_val">{Number.isFinite(edit_origin?.fov) ? edit_origin.fov : cfg_num("Default field of view (deg)", 60)}°</span>
        <button on:click={() => change_fov(5)}>+</button>
      </div>
      <div class="ce_info">
        {#if edit_mode === "direction"}
          Cliquez sur la carte vers où regarde la caméra à l'image affichée.
        {:else if edit_mode === "position"}
          Cliquez sur la carte où se trouve la caméra à l'image affichée.
        {:else}
          cap {Number.isFinite(edit_origin?.bearing) ? edit_origin.bearing + "°" : "non défini"}
          {#if $trajectories_store[edit_uar]}· trajectoire {$trajectories_store[edit_uar][0].relative ? "relative" : "absolue"}{/if}
        {/if}
      </div>
      {#if save_state}<div class="ce_state">{save_state}</div>{/if}
    </div>
  {/if}
  {#if $platform_config_store["Map start latitude"] !== undefined}
    <Map
      bind:this={mapComponent}
      accessToken={MAPBOX_ACCESS_TOKEN}
      options={{
        style: "mapbox://styles/situmapping/cl27sefh1000r15o2yvb5er0k",
        center: [
          parseFloat($platform_config_store["Map start longitude"]),
          parseFloat($platform_config_store["Map start latitude"]),
        ],
        doubleClickZoom: false,
      }}
      zoom={parseFloat($platform_config_store["Map start zoom"])}
      on:ready={on_map_ready}
    >
      <style>
        a.mapboxgl-ctrl-logo,
        #map
          > div.mapboxgl-control-container
          > div.mapboxgl-ctrl-bottom-right
          > div {
          visibility: hidden;
        }
      </style>
      <NavigationControl />
      <ScaleControl />
      <!-- {#each Object.values($media_store_filtered) as medium} -->
      {#each Object.values($media_store_filtered).filter((video) => poses[video.UAR]) as medium (medium.UAR)}
        <span>
          <Marker lat={poses[medium.UAR].lat} lng={poses[medium.UAR].lon} popup={false}>
            <div
              on:click={onMarkerClick}
              on:mouseover={onMarkerOver}
              on:mouseout={onMarkerOut}
              data-UAR={medium.UAR}
              style="
                              font-size:{$ui_store.media_hovered.includes(
                medium.UAR,
              ) || $ui_store.media_in_view.includes(medium.UAR)
                ? '60px'
                : '30px'};
                              color:red"
            >
              {$ui_store.media_in_view.includes(medium.UAR) ? "•" : "◦"}
            </div>
          </Marker>
        </span>
      {/each}
    </Map>
  {/if}
</span>

<style>
  :global(.mapboxgl-marker) {
    cursor: pointer;
  }

  .map_container {
    position: relative;
    display: block;
    height: 100%;
    width: 100%;
  }

  .cone_editor {
    position: absolute;
    z-index: 5;
    top: 8px;
    left: 8px;
    background: rgba(0, 0, 0, 0.82);
    color: white;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    max-width: 320px;
  }
  .ce_row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0;
  }
  .cone_editor button {
    background: #222;
    color: white;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 1px 7px;
    cursor: pointer;
    font-size: 12px;
  }
  .cone_editor button.on {
    background: #d90c1e;
    border-color: #d90c1e;
  }
  .ce_sep {
    width: 8px;
  }
  .ce_info,
  .ce_state {
    color: #ccc;
    font-size: 11px;
  }
</style>
