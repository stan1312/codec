<script>
  import { onMount } from "svelte";
  import {
    local_file_store,
    platform_config_store,
    playback_store,
  } from "../../stores/store";
  import { attachVideoSync } from "../../lib/videoSync";
  import { play, pause, seekTo } from "../../lib/clock";
  export let medium;

  let src;
  let used_filepath;
  if ($platform_config_store["Source of media files"].includes("local")) {
    try {
      used_filepath = $local_file_store[medium.UAR].name;
      src = URL.createObjectURL($local_file_store[medium.UAR]);
    } catch {
      src = null;
    }
  } else {
    used_filepath =
      medium[$platform_config_store["Title of column used for url"]];
    src = used_filepath;
  }

  const is_video = (p) =>
    ["mp4", "mov", "webm", "m4v"].some((ext) => p?.toLowerCase().includes(ext));
  const is_image = (p) =>
    ["png", "jpeg", "jpg", "webp"].some((ext) => p?.toLowerCase().includes(ext));

  // ---- synchronisation with the master clock (see src/lib/videoSync.js) ----
  let video;
  // a video can only be synced if it has a chronolocation
  const can_sync = medium?.start instanceof Date && !isNaN(medium.start);
  let synced = can_sync;
  let status = "sync"; // before | after | sync
  let vs = null;

  onMount(() => {
    if (!can_sync || !video) return;
    vs = attachVideoSync(video, medium.start.getTime(), {
      onUserSeek: (ms) => seekTo(ms),
      onUserPlay: () => play(),
      onUserPause: () => pause(),
      onStatus: (s) => (status = s),
    });
    const unsubscribe = playback_store.subscribe((p) => vs.update(p));
    return () => {
      unsubscribe();
      vs.destroy();
    };
  });

  // the chronolocation can be corrected in the sheet while the clip is open
  $: if (vs && medium?.start instanceof Date) vs.setStart(medium.start.getTime());

  function toggle_sync() {
    synced = !synced;
    vs?.setEnabled(synced);
  }
</script>

{#if src !== null}
  {#if is_video(used_filepath)}
    <div class="medium_video" id={medium.id}>
      <!-- svelte-ignore a11y-media-has-caption -->
      <video
        bind:this={video}
        controls
        muted
        preload="auto"
        {src}
      />
      {#if can_sync}
        <button
          class="sync_toggle"
          class:off={!synced}
          title="Lier cette vidéo au curseur global"
          on:click={toggle_sync}
        >
          {synced ? "synchro" : "libre"}
        </button>
        {#if synced && (status === "before" || status === "after")}
          <div class="out_of_range">
            {status === "before" ? "pas encore commencée" : "terminée"}
          </div>
        {/if}
      {/if}
    </div>
  {:else if is_image(used_filepath)}
    <div class="medium_image" id={medium.id}>
      <!-- svelte-ignore a11y-missing-attribute -->
      <img {src} />
    </div>
  {/if}
{/if}

<style>
  .medium_video {
    position: relative;
    width: 100%;
    height: 40vh;
    margin: 0 auto;
    overflow: hidden;
  }

  .medium_image {
    height: 40vh;
    display: flex;
    flex-flow: column;
    flex-direction: row;
    justify-content: center;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .sync_toggle {
    position: absolute;
    top: 6px;
    right: 6px;
    font-size: 11px;
    padding: 2px 6px;
    background: #d90c1e;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.85;
  }

  .sync_toggle.off {
    background: #555;
  }

  .out_of_range {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    font-size: 14px;
    pointer-events: none;
  }
</style>
