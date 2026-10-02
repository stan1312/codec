<script>
  import { onMount } from "svelte";
  import {
    local_file_store,
    platform_config_store,
    playback_store,
  } from "../../stores/store";
  import { attachVideoSync } from "../../lib/videoSync";
  import { play, pause, seekTo } from "../../lib/clock";
  import { sheetWrite, friendlyError } from "../../lib/sheetClient";
  import { cfgGet } from "../../lib/columns";
  import { sheet_refresh } from "../../stores/store";
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

  // ---- re-synchronisation from the platform (saved to "Sync offset (s)") ----
  let offset_local = null; // offset just set here, until the sheet shows it
  let save_msg = "";
  let save_timer = null;
  $: sheet_offset = Number.isFinite(medium?.sync_offset) ? medium.sync_offset : 0;
  $: if (offset_local !== null && Math.abs(offset_local - sheet_offset) < 0.0005) offset_local = null;
  $: offset = offset_local !== null ? offset_local : sheet_offset;
  $: start_raw = medium?.start_raw instanceof Date ? medium.start_raw.getTime() : medium?.start?.getTime();
  // effective start (chronolocation + offset); also follows edits made in the sheet
  $: if (vs && Number.isFinite(start_raw)) vs.setStart(start_raw + offset * 1000);

  const round2 = (x) => Math.round(x * 100) / 100;

  function set_offset(v) {
    offset_local = round2(v);
    save_msg = "…";
    clearTimeout(save_timer);
    save_timer = setTimeout(async () => {
      const col = cfgGet($platform_config_store, "Title of column used for sync offset");
      try {
        await sheetWrite({ action: "update_media", uar: medium.UAR, values: { [col]: offset_local } });
        save_msg = "enregistré";
        $sheet_refresh += 1;
      } catch (e) {
        save_msg = friendlyError(e);
      }
    }, 600);
  }

  // "caler ici": the frame shown in this (free) video happens at the cursor time
  function align_here() {
    if (!video || !Number.isFinite(start_raw) || !Number.isFinite($playback_store.time)) return;
    set_offset(($playback_store.time - start_raw) / 1000 - video.currentTime);
    synced = true;
    vs?.setEnabled(true);
  }

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
    {#if can_sync}
      <div class="resync" on:pointerdown|stopPropagation>
        <span title="Décalage ajouté à l'heure de captation (colonne Sync offset)">
          décalage {offset >= 0 ? "+" : ""}{offset.toFixed(2)} s
        </span>
        <button title="Vidéo 1 s plus tôt" on:click={() => set_offset(offset - 1)}>−1s</button>
        <button title="Vidéo 0,1 s plus tôt" on:click={() => set_offset(offset - 0.1)}>−0.1</button>
        <button title="Vidéo 0,1 s plus tard" on:click={() => set_offset(offset + 0.1)}>+0.1</button>
        <button title="Vidéo 1 s plus tard" on:click={() => set_offset(offset + 1)}>+1s</button>
        <button
          class="align"
          disabled={synced}
          title={synced
            ? "Passez la vidéo en « libre », amenez-la à l'image de l'événement, placez le curseur sur l'heure de l'événement, puis cliquez"
            : "L'image affichée correspond à l'heure du curseur"}
          on:click={align_here}>caler ici</button
        >
        {#if save_msg}<span class="msg">{save_msg}</span>{/if}
      </div>
    {/if}
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
    height: 26vh;
    margin: 0 auto;
    overflow: hidden;
  }

  .medium_image {
    height: 26vh;
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

  .resync {
    display: flex;
    flex-flow: row wrap;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: #ccc;
    padding: 3px 2px 0 2px;
  }
  .resync button {
    background: #222;
    color: white;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 0 5px;
    font-size: 11px;
    line-height: 16px;
    cursor: pointer;
  }
  .resync button.align {
    background: #d90c1e;
    border-color: #d90c1e;
  }
  .resync button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .resync .msg {
    color: #999;
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
