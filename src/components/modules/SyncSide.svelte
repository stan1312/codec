<script>
  // One side of "Synchroniser 2 vidéos": its own player (independent of the
  // red cursor), the whole sound of the clip, a zoom around the current image,
  // and a mark ("ce moment").
  import { onDestroy, tick } from "svelte";
  import { createEventDispatcher } from "svelte";
  import { platform_config_store, local_file_store } from "../../stores/store";
  import { formatClock } from "../../lib/sync";
  import { drawWaveform } from "../../lib/audio";
  import { waveforms, requestWaveforms, retryWaveform, mediaSource } from "../../lib/waveforms";

  export let medium = null; // the media row (start = effective start)
  export let role = "master"; // master | moving
  export let mark = null; // seconds in the clip
  export let video = null; // exposed to the parent (play together)
  export let candidates = [];
  export let uar = "";
  export let exclude = "";

  const dispatch = createEventDispatcher();
  const FRAME = 1 / 30;

  // ---- source (local file or URL), independent <video> ----
  let src = null;
  let objectUrl = null;
  let srcKey = null;
  $: source = medium ? mediaSource(medium, $platform_config_store, $local_file_store) : null;
  $: if (source !== srcKey) {
    srcKey = source;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (source && typeof source !== "string") objectUrl = URL.createObjectURL(source);
    src = objectUrl || source || null;
    t = 0;
    duration = 0;
    ready = false;
    load_error = "";
  }
  onDestroy(() => objectUrl && URL.revokeObjectURL(objectUrl));
  function pickFile(e) {
    const f = e.target.files && e.target.files[0];
    if (f && medium) $local_file_store = { ...$local_file_store, [medium.UAR]: f };
  }

  let t = 0; // current time in the clip (s)
  let duration = 0;
  let paused = true;
  let muted = true;
  let ready = false;
  let load_error = "";
  function onMeta() {
    duration = video.duration || 0;
    // show the first image right away (Safari shows nothing otherwise)
    if (video.currentTime === 0) video.currentTime = 0.001;
  }

  // ---- sound ----
  $: if (medium && source) requestWaveforms([medium], $platform_config_store, $local_file_store);
  $: w = medium ? $waveforms[medium.UAR] : null;
  $: total = duration || (w && w.duration) || (medium ? (new Date(medium.end) - medium.start) / 1000 : 0) || 0;

  // ---- transport ----
  export function seek(s) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(total || 1e9, s));
  }
  const step = (d) => {
    video?.pause();
    seek(t + d);
  };
  function toggle() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  // ---- zoom window around the current image ----
  const zooms = [2, 5, 10, 30, 120];
  let zoom = 10;
  $: z0 = Math.max(0, Math.min(Math.max(0, total - zoom), t - zoom / 2));
  $: z1 = z0 + zoom;

  // ---- drawing ----
  let cOver;
  let cZoom;
  const COLOR = { master: "rgba(255,255,255,0.85)", moving: "rgba(120,200,255,0.95)" };
  function paint(canvas, a, b, withWindow) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, canvas.clientWidth);
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const x = (s) => ((s - a) / (b - a)) * W;
    if (w && w.status === "ok") drawWaveform(g, w.env, { width: W, height: H, color: COLOR[role], from: a * w.rate, to: b * w.rate });
    if (withWindow) {
      g.fillStyle = "rgba(255,255,255,0.12)";
      g.fillRect(x(z0), 0, Math.max(2, x(z1) - x(z0)), H);
    }
    if (mark !== null) {
      g.fillStyle = "#ffd400";
      g.fillRect(x(mark) - 1, 0, 2, H);
    }
    g.fillStyle = "#ff1a2e";
    g.fillRect(x(t) - 0.5, 0, 1.5, H);
  }
  $: {
    w, t, mark, z0, z1, total, role;
    tick().then(() => {
      paint(cOver, 0, Math.max(total, 0.1), true);
      paint(cZoom, z0, z1, false);
    });
  }
  function clickStrip(e, a, b) {
    const r = e.currentTarget.getBoundingClientRect();
    video?.pause();
    seek(a + ((e.clientX - r.left) / r.width) * (b - a));
  }
  function wheelZoom(e) {
    e.preventDefault();
    const i = zooms.indexOf(zoom);
    zoom = zooms[Math.max(0, Math.min(zooms.length - 1, i + (e.deltaY > 0 ? 1 : -1)))];
  }

  const abs = (s) => (medium ? formatClock(medium.start.getTime() + s * 1000, 3) : "");
</script>

<div class="side {role}">
  <div class="top">
    <span class="tag">{role === "master" ? "MAÎTRE (ne bouge pas)" : "À DÉCALER"}</span>
    <select bind:value={uar} on:change={() => dispatch("change")}>
      <option value="" disabled>choisir une vidéo…</option>
      {#each candidates.filter((m) => m.UAR !== exclude) as m}<option value={m.UAR}>{m.UAR}</option>{/each}
    </select>
    {#if role === "master"}<button class="swap" title="Échanger maître et vidéo à décaler" on:click={() => dispatch("swap")}>⇄</button>{/if}
  </div>

  {#if !medium}
    <div class="empty">Choisissez une vidéo.</div>
  {:else if !src}
    <div class="empty">
      Le fichier de <b>{medium.UAR}</b> n'est pas chargé.<br />
      <label class="pick"
        >choisir le fichier sur l'ordinateur…
        <input type="file" accept="video/*,.mov,.mp4,.m4v" on:change={pickFile} /></label
      >
    </div>
  {:else}
    <div class="player">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video
        bind:this={video}
        {src}
        preload="auto"
        playsinline
        bind:currentTime={t}
        bind:paused
        bind:muted
        on:loadedmetadata={onMeta}
        on:loadeddata={() => (ready = true)}
        on:error={() => (load_error = "lecture impossible dans ce navigateur")}
        on:click={toggle}
      />
      {#if !ready && !load_error}<div class="over">chargement de la vidéo…</div>{/if}
      {#if load_error}<div class="over err">{load_error}</div>{/if}
    </div>

    <div class="ctrl">
      <button title="−1 s" on:click={() => step(-1)}>−1s</button>
      <button title="Image précédente" on:click={() => step(-FRAME)}>◀ img</button>
      <button class="play" on:click={toggle}>{paused ? "▶" : "❚❚"}</button>
      <button title="Image suivante" on:click={() => step(FRAME)}>img ▶</button>
      <button title="+1 s" on:click={() => step(1)}>+1s</button>
      <button class:on={!muted} title="Son" on:click={() => (muted = !muted)}>{muted ? "🔇" : "🔊"}</button>
      <span class="time" title="Temps dans la vidéo · heure sur la timeline">{t.toFixed(3)} s · {abs(t)}</span>
    </div>

    <div class="strips">
      <div class="lbl">vidéo entière</div>
      <canvas bind:this={cOver} class="over_strip" on:click={(e) => clickStrip(e, 0, Math.max(total, 0.1))} />
      <div class="lbl">
        zoom
        <select bind:value={zoom}>
          {#each zooms as z}<option value={z}>{z} s</option>{/each}
        </select>
      </div>
      <canvas bind:this={cZoom} class="zoom_strip" on:click={(e) => clickStrip(e, z0, z1)} on:wheel={wheelZoom} />
      {#if w && w.status !== "ok"}
        <div class="wstate">
          {#if w.status === "error"}⚠ {w.error} <button on:click={() => retryWaveform(medium.UAR)}>réessayer</button>
          {:else}chargement du son…{/if}
        </div>
      {/if}
    </div>

    <div class="markrow">
      <button class="mark" on:click={() => (mark = t)} title="Le moment affiché (image + son) est le repère">📍 marquer ce moment</button>
      {#if mark !== null}
        <span class="markinfo">repère {mark.toFixed(3)} s · {abs(mark)}</span>
        <button title="Revenir au repère" on:click={() => seek(mark)}>aller</button>
        <button title="Effacer le repère" on:click={() => (mark = null)}>✕</button>
      {:else}
        <span class="hint">aucun repère</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .side {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 5px;
    border-radius: 4px;
    border: 1px solid #333;
  }
  .side.master {
    border-color: #777;
  }
  .side.moving {
    border-color: #2f6f99;
  }
  .top {
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .tag {
    font-size: 9px;
    font-weight: bold;
    border-radius: 8px;
    padding: 1px 7px;
    white-space: nowrap;
  }
  .master .tag {
    background: white;
    color: black;
  }
  .moving .tag {
    background: #78c8ff;
    color: black;
  }
  .top select {
    flex: 1 1 auto;
    min-width: 0;
  }
  .empty {
    color: #aaa;
    padding: 20px 6px;
    text-align: center;
    line-height: 1.8;
  }
  .pick {
    display: inline-block;
    background: #d90c1e;
    color: white;
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .pick input {
    display: none;
  }
  .player {
    position: relative;
    background: black;
    height: 22vh;
    min-height: 120px;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }
  .over {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ccc;
    background: rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .over.err {
    color: #ff8080;
  }
  .ctrl,
  .markrow {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-wrap: wrap;
  }
  .time,
  .markinfo {
    font-family: monospace;
    color: #ddd;
    margin-left: 4px;
  }
  .markinfo {
    color: #ffd400;
  }
  .hint {
    color: #777;
  }
  .strips {
    position: relative;
    display: grid;
    grid-template-columns: 62px 1fr;
    gap: 2px 4px;
    align-items: center;
  }
  .lbl {
    color: #888;
    font-size: 10px;
  }
  .lbl select {
    font-size: 10px;
    padding: 0 2px;
  }
  canvas {
    width: 100%;
    display: block;
    background: #0b0b0b;
    border: 1px solid #2a2a2a;
    cursor: crosshair;
  }
  .over_strip {
    height: 22px;
  }
  .zoom_strip {
    height: 56px;
  }
  .wstate {
    position: absolute;
    left: 70px;
    top: 3px;
    color: #ffb000;
  }
  button,
  select {
    background: #222;
    color: white;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 0 5px;
    font-size: 11px;
    line-height: 17px;
    cursor: pointer;
  }
  button.play {
    background: #d90c1e;
    border-color: #d90c1e;
    min-width: 30px;
  }
  button.on {
    background: #eee;
    color: black;
  }
  button.mark {
    background: #ffd400;
    color: black;
    border-color: #ffd400;
    font-weight: bold;
  }
</style>
