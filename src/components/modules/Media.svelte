<script>
  import { ui_store, media_store } from "../../stores/store";
  import Module from "./Module.svelte";
</script>

<div class="media">
  <!-- newest first, stacked vertically -->
  {#each [...$ui_store.media_in_view].reverse() as UAR (UAR)}
    <Module module={"media"} medium={$media_store[UAR]} />
  {/each}
</div>

<style>
  .media {
    flex: 1 1 auto;
    display: flex;
    flex-flow: column nowrap;
    gap: var(--grid-size);
    overflow-y: auto;
    min-height: 0;
  }
</style>
