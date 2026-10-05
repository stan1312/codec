<script>
  import { onMount } from "svelte";
  import { playback_store, media_store_filtered, platform_config_store, local_file_store } from "../../stores/store";
  import { togglePlay, seekBy, setRate } from "../../lib/clock";
  import { formatClock } from "../../lib/sync";
  import { drag_unlocked, drag_info, sync_panel_open, sync_history, undoSync, hasChrono } from "../../lib/syncEdit";
  import { waveforms, waves_on, requestWaveforms, waveCounts } from "../../lib/waveforms";

  // waveforms: computed for every video of the timeline when switched on
  $: if ($waves_on)
    requestWaveforms(Object.values($media_store_filtered).filter(hasChrono), $platform_config_store, $local_file_store);
  $: wc = waveCounts($waveforms);
  $: wave_errors = Object.entries($waveforms)
    .filter(([, w]) => w.status === "error")
    .map(([u, w]) => `${u} : ${w.error}`)
    .join("\n");

  const rates = [0.1, 0.25, 0.5, 1, 2, 4];

  function on_rate_change(e) {
    setRate(parseFloat(e.target.value));
  }

  // keyboard shortcuts: space = play/pause, arrows = ±1 s, shift+arrows = ±0.1 s
  function on_keydown(e) {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
      e.preventDefault();
      const step = e.shiftKey ? 100 : 1000;
      seekBy(e.code === "ArrowRight" ? step : -step);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", on_keydown);
    return () => window.removeEventListener("keydown", on_keydown);
  });
</script>

<div class="transport" on:pointerdown={(e) => e.stopPropagation()}>
  <button title="-10 s" on:click={() => seekBy(-10000)}>-10s</button>
  <button title="-1 s (←)" on:click={() => seekBy(-1000)}>-1s</button>
  <button title="-0,1 s (Maj+←)" on:click={() => seekBy(-100)}>-0.1</button>
  <button class="play" title="Lecture / pause (espace)" on:click={togglePlay}>
    {$playback_store.playing ? "❚❚" : "▶"}
  </button>
  <button title="+0,1 s (Maj+→)" on:click={() => seekBy(100)}>+0.1</button>
  <button title="+1 s (→)" on:click={() => seekBy(1000)}>+1s</button>
  <button title="+10 s" on:click={() => seekBy(10000)}>+10s</button>
  <select title="Vitesse" value={String($playback_store.rate)} on:change={on_rate_change}>
    {#each rates as r}
      <option value={String(r)}>×{r}</option>
    {/each}
  </select>
  <span class="clock">{formatClock($playback_store.time, 1)}</span>

  <span class="sep" />
  <span class="lbl">synchro</span>
  <button
    class:on={$drag_unlocked}
    title={$drag_unlocked
      ? "Les vidéos se déplacent à la souris sur la timeline (cliquer pour verrouiller)"
      : "Déverrouiller pour glisser les vidéos sur la timeline et corriger leur heure"}
    on:click={() => ($drag_unlocked = !$drag_unlocked)}>{$drag_unlocked ? "🔓 glisser" : "🔒 glisser"}</button
  >
  <button
    class:on={$waves_on}
    title={"Afficher le son (forme d'onde) dans les barres de la timeline" + (wave_errors ? "\n\nSans onde :\n" + wave_errors : "")}
    on:click={() => ($waves_on = !$waves_on)}
    >ondes{#if $waves_on && (wc.busy || wc.err)}<small>
        {wc.busy ? ` ${wc.ok}/${wc.ok + wc.busy}…` : ""}{wc.err ? ` ⚠${wc.err}` : ""}</small
      >{/if}</button
  >
  <button class:on={$sync_panel_open} class="two" title="Caler une vidéo sur une autre (image ou son)" on:click={() => ($sync_panel_open = !$sync_panel_open)}
    >synchroniser 2 vidéos</button
  >
  <button disabled={!$sync_history.length} title="Annuler la dernière modification de synchro" on:click={undoSync}>↶</button>
  {#if $drag_info}
    <span class="drag">
      {$drag_info.uar} : début {formatClock($drag_info.start, 3)} ({$drag_info.offset >= 0 ? "+" : ""}{$drag_info.offset.toFixed(3)} s)
    </span>
  {/if}
</div>

<style>
  .transport {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    overflow-x: auto;
    white-space: nowrap;
    gap: 4px;
    padding: 0 4px 3px 4px;
    font-size: 11px;
  }

  button,
  select {
    background: #222;
    color: white;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 0 5px;
    font-size: 11px;
    line-height: 16px;
    cursor: pointer;
  }

  button.play {
    background: #d90c1e;
    border-color: #d90c1e;
    min-width: 34px;
  }

  .sep {
    width: 1px;
    height: 14px;
    background: #555;
    margin: 0 6px;
  }
  .lbl {
    color: #888;
  }
  button.on {
    background: #eee;
    color: black;
    border-color: #eee;
  }
  button.two {
    border-color: #d90c1e;
  }
  button.two.on {
    background: #d90c1e;
    color: white;
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  small {
    font-size: 10px;
  }
  .drag {
    font-family: monospace;
    color: #ffd400;
    white-space: nowrap;
    overflow: hidden;
  }

  .clock {
    margin-left: 8px;
    font-family: monospace;
    font-size: 13px;
    color: white;
  }
</style>
