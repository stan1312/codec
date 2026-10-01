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
  } from "../../stores/store";
  import { conePolygon, poseAt } from "../../lib/geo";
  import { mediaTimeFor } from "../../lib/sync";
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

  // Current pose of every medium: { UAR: {lat, lon, bearing, active} }
  function compute_poses(media, trajectories, time) {
    const poses = {};
    for (const medium of Object.values(media)) {
      const has_time = medium.start instanceof Date && !isNaN(medium.start);
      const active =
        has_time && Number.isFinite(time) && time >= medium.start.getTime() && time <= new Date(medium.end).getTime();
      const track = trajectories[medium.UAR];
      let pose = null;
      if (track && track.length) {
        const t = has_time && Number.isFinite(time) ? mediaTimeFor(time, medium.start.getTime()) : 0;
        pose = poseAt(track, t);
        if (pose && !Number.isFinite(pose.bearing)) pose.bearing = medium.bearing;
      } else if (!isNaN(medium.lat) && !isNaN(medium.long)) {
        pose = { lat: medium.lat, lon: medium.long, bearing: medium.bearing };
      }
      if (pose) poses[medium.UAR] = { ...pose, active };
    }
    return poses;
  }

  $: poses = compute_poses($media_store_filtered, $trajectories_store, $playback_store.time);

  function build_features() {
    const length = cfg_num("Cone length (m)", 40);
    const default_fov = cfg_num("Default field of view (deg)", 60);
    const cones = [];
    const paths = [];
    for (const [UAR, pose] of Object.entries(poses)) {
      const medium = $media_store_filtered[UAR];
      const selected = $ui_store.media_in_view.includes(UAR) || $ui_store.media_hovered.includes(UAR);
      if (Number.isFinite(pose.bearing)) {
        const fov = Number.isFinite(medium?.fov) ? medium.fov : default_fov;
        cones.push({
          type: "Feature",
          properties: { UAR, active: pose.active, selected },
          geometry: { type: "Polygon", coordinates: [conePolygon(pose.lat, pose.lon, pose.bearing, fov, length)] },
        });
      }
      const track = $trajectories_store[UAR];
      if (track && track.length > 1) {
        paths.push({
          type: "Feature",
          properties: { UAR, active: pose.active, selected },
          geometry: { type: "LineString", coordinates: track.map((p) => [p.lon, p.lat]) },
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

  $: poses, $ui_store, layers_ready, schedule_update();

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
    height: 100%;
    width: 100%;
  }
</style>
