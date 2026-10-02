<script>
  // Layout: the map fills the screen; the timeline floats at the bottom
  // (slightly transparent) and the videos float on the right (scrollable).
  import Module from "./Module.svelte";
  import Media from "./Media.svelte";
  import { ui_store } from "../../stores/store";

  $: show = (m) => $ui_store.modules_in_view.includes(m);
</script>

<div
  id="modules_container"
  class:no_media={!show("media") || $ui_store.media_in_view.length === 0}
  class:no_timeline={!show("timeline")}
>
  <div id="map_area"><Module module={"map"} /></div>
  <div id="media_area"><Media /></div>
  <div id="timeline_area"><Module module={"timeline"} /></div>
</div>

<style>
  #modules_container {
    --timeline-h: clamp(110px, 17vh, 190px);
    --gap: var(--grid-size);
    position: relative;
    height: calc(100vh - 6 * var(--grid-size));
    width: 100%;
  }

  #map_area {
    position: absolute;
    inset: 0;
    display: flex;
  }

  #media_area {
    position: absolute;
    z-index: 6;
    top: var(--gap);
    right: var(--gap);
    bottom: calc(var(--timeline-h) + 2 * var(--gap));
    width: min(33%, 560px);
    display: flex;
    pointer-events: none; /* clicks pass to the map between the videos */
  }
  #media_area > :global(*) {
    pointer-events: auto;
  }
  #modules_container.no_media #media_area {
    display: none;
  }
  #modules_container.no_timeline #media_area {
    bottom: var(--gap);
  }

  #timeline_area {
    position: absolute;
    z-index: 7;
    left: var(--gap);
    right: var(--gap);
    bottom: var(--gap);
    height: var(--timeline-h);
    display: flex;
  }
  #modules_container.no_timeline #timeline_area {
    display: none;
  }

  #map_area > :global(.module),
  #timeline_area > :global(.module) {
    flex: 1 1 auto;
    margin: 0;
    min-height: 0;
  }
  /* keep the map controls / attribution above the floating timeline */
  #map_area :global(.mapboxgl-ctrl-bottom-left),
  #map_area :global(.mapboxgl-ctrl-bottom-right) {
    bottom: calc(var(--timeline-h) + 2 * var(--gap));
  }
  #modules_container:not(.no_timeline) #map_area :global(.mapboxgl-ctrl-bottom-right) {
    right: 0;
  }
  #modules_container:not(.no_media) #map_area :global(.mapboxgl-ctrl-bottom-right) {
    right: calc(min(33%, 560px) + 2 * var(--gap));
  }
  #modules_container.no_timeline #map_area :global(.mapboxgl-ctrl-bottom-left),
  #modules_container.no_timeline #map_area :global(.mapboxgl-ctrl-bottom-right) {
    bottom: 0;
  }

  /* see the map through the timeline */
  #timeline_area > :global(.module) {
    background-color: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(1px);
  }
  #media_area :global(.media_module) {
    background-color: rgba(0, 0, 0, 0.9);
  }
</style>
