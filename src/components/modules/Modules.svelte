<script>
  // Layout: map (2/3) and stacked videos (1/3) on top, thin timeline at the bottom.
  import Module from "./Module.svelte";
  import Media from "./Media.svelte";
  import { ui_store } from "../../stores/store";

  $: show = (m) => $ui_store.modules_in_view.includes(m);
</script>

<div
  id="modules_container"
  class:no_media={!show("media") || $ui_store.media_in_view.length === 0}
  class:no_map={!show("map")}
  class:no_timeline={!show("timeline")}
>
  <div id="map_area"><Module module={"map"} /></div>
  <div id="media_area"><Media /></div>
  <div id="timeline_area"><Module module={"timeline"} /></div>
</div>

<style>
  #modules_container {
    height: calc(100vh - 6 * var(--grid-size));
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) clamp(110px, 17vh, 190px);
    grid-template-areas:
      "map media"
      "timeline timeline";
    gap: var(--grid-size);
  }

  /* no video open: the map takes the whole width */
  #modules_container.no_media {
    grid-template-areas:
      "map map"
      "timeline timeline";
  }
  #modules_container.no_map {
    grid-template-areas:
      "media media"
      "timeline timeline";
  }
  #modules_container.no_map.no_media {
    grid-template-areas:
      "map map"
      "timeline timeline";
  }
  #modules_container.no_timeline {
    grid-template-rows: minmax(0, 1fr) 0;
  }

  #map_area {
    grid-area: map;
    min-height: 0;
    display: flex;
  }
  #media_area {
    grid-area: media;
    min-height: 0;
    display: flex;
  }
  #timeline_area {
    grid-area: timeline;
    min-height: 0;
    display: flex;
  }
  #modules_container.no_map #map_area {
    display: none;
  }
  #modules_container.no_media:not(.no_map) #media_area {
    display: none;
  }
  #map_area > :global(.module),
  #timeline_area > :global(.module) {
    flex: 1 1 auto;
    margin: 0;
    min-height: 0;
  }
</style>
