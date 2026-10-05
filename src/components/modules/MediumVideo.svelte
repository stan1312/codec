<script>
  import { onMount } from "svelte";
  import {
    local_file_store,
    platform_config_store,
    playback_store,
  } from "../../stores/store";
  import { attachVideoSync } from "../../lib/videoSync";
  import { play, pause, seekTo } from "../../lib/clock";
  import { formatClock, parseTimeInput } from "../../lib/sync";
  import { setSyncOffset, setStartTime, offsetOf, hasChrono, sync_save } from "../../lib/syncEdit";
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

  // ---- re-synchronisation (all tools go through src/lib/syncEdit.js) ----
  // effective start = chronolocation of the sheet + "Sync offset (s)"
  $: offset = offsetOf(medium);
  $: if (vs && medium?.start instanceof Date) vs.setStart(medium.start.getTime());
  $: save_msg = $sync_save[medium?.UAR] || "";

  // exact start time typed by hand
  let start_text = "";
  let editing_start = false;
  let start_error = false;
  $: if (!editing_start) start_text = medium?.start instanceof Date ? formatClock(medium.start.getTime(), 3) : "";

  function apply_start() {
    const ms = parseTimeInput(start_text, medium.start_raw?.getTime());
    if (!Number.isFinite(ms)) {
      start_error = true;
      return;
    }
    start_error = false;
    editing_start = false;
    setStartTime(medium.UAR, ms);
    start_input?.blur();
  }
  let start_input;
  function start_key(e) {
    if (e.key === "Enter") apply_start();
    else if (e.key === "Escape") {
      editing_start = false;
      start_error = false;
      start_input?.blur();
    }
  }

  const nudge = (d) => setSyncOffset(medium.UAR, offset + d);

  // "caler ici": the frame shown in this (free) video happens at the cursor time
  function align_here() {
    if (!video || !hasChrono(medium) || !Number.isFinite($playback_store.time)) return;
    setSyncOffset(medium.UAR, ($playback_store.time - medium.start_raw.getTime()) / 1000 - video.currentTime);
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
        <div class="row">
          <span class="lbl" title="Heure exacte de la première image de la vidéo">début</span>
          <input
            class="start"
            class:error={start_error}
            bind:this={start_input}
            bind:value={start_text}
            on:focus={() => (editing_start = true)}
            on:keydown={start_key}
            placeholder="hh:mm:ss.mmm"
            title="Tapez l'heure exacte de la 1re image puis Entrée. Formats : 20:47:10.250, 20:47:10:250, 20:47:10, ou avec la date 2026-06-14 20:47:10.250"
          />
          <button class="ok" on:click={apply_start} title="Placer la vidéo à cette heure">OK</button>
          {#if editing_start}<button on:click={() => { editing_start = false; start_error = false; }} title="Annuler">✕</button>{/if}
          <span class="off" title="Décalage ajouté à l'heure de captation du sheet (colonne Sync offset)">
            {offset >= 0 ? "+" : ""}{offset.toFixed(3)} s
          </span>
          {#if save_msg}<span class="msg">{save_msg}</span>{/if}
        </div>
        <div class="row">
          <span class="lbl">décaler</span>
          <button title="Vidéo 1 s plus tôt" on:click={() => nudge(-1)}>−1s</button>
          <button title="Vidéo 0,1 s plus tôt" on:click={() => nudge(-0.1)}>−0.1</button>
          <button title="Vidéo 1/25 s plus tôt" on:click={() => nudge(-0.04)}>−1img</button>
          <button title="Vidéo 1/25 s plus tard" on:click={() => nudge(0.04)}>+1img</button>
          <button title="Vidéo 0,1 s plus tard" on:click={() => nudge(0.1)}>+0.1</button>
          <button title="Vidéo 1 s plus tard" on:click={() => nudge(1)}>+1s</button>
          <button
            class="align"
            disabled={synced}
            title={synced
              ? "Passez la vidéo en « libre » (bouton en haut à droite), amenez-la à l'image d'un événement, placez le curseur rouge de la timeline sur l'heure de cet événement, puis cliquez"
              : "L'image affichée a lieu à l'heure du curseur rouge"}
            on:click={align_here}>caler sur le curseur</button
          >
        </div>
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
    flex-flow: column nowrap;
    gap: 3px;
    font-size: 11px;
    color: #ccc;
    padding: 3px 2px 0 2px;
  }
  .resync .row {
    display: flex;
    flex-flow: row wrap;
    align-items: center;
    gap: 3px;
  }
  .resync .lbl {
    width: 42px;
    color: #888;
  }
  .resync input.start {
    width: 92px;
    background: #111;
    color: white;
    border: 1px solid #555;
    border-radius: 3px;
    font-family: monospace;
    font-size: 12px;
    padding: 0 4px;
    line-height: 16px;
  }
  .resync input.start:focus {
    border-color: white;
    outline: none;
  }
  .resync input.start.error {
    border-color: #ff1a2e;
  }
  .resync .off {
    font-family: monospace;
    color: #aaa;
    margin-left: 4px;
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
  .resync button.ok {
    background: #444;
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
