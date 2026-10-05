<script>
  // "Synchroniser 2 vidéos": the master does not move, the other video is
  // shifted so that the same moment (marked on the image or on the sound)
  // happens at the same time in both. Saved to "Sync offset (s)".
  import { onMount, tick } from "svelte";
  import { media_store, ui_store, playback_store, platform_config_store, local_file_store } from "../../stores/store";
  import { seekTo } from "../../lib/clock";
  import { formatClock, offsetAfterAlign } from "../../lib/sync";
  import { bestLag, drawWaveform } from "../../lib/audio";
  import { setSyncOffset, offsetOf, hasChrono, sync_panel_open, sync_save, undoSync, sync_history } from "../../lib/syncEdit";
  import { waveforms, requestWaveforms, retryWaveform } from "../../lib/waveforms";

  $: candidates = Object.values($media_store)
    .filter(hasChrono)
    .sort((a, b) => a.start - b.start);

  // defaults: the two last opened videos, otherwise the first two
  let uarA = "";
  let uarB = "";
  $: if (!uarA || !uarB) {
    const open = $ui_store.media_in_view.filter((u) => candidates.some((m) => m.UAR === u));
    const pool = [...open.slice(-2), ...candidates.map((m) => m.UAR)].filter((u, i, a) => a.indexOf(u) === i);
    if (!uarA) uarA = pool[0] || "";
    if (!uarB) uarB = pool.find((u) => u !== uarA) || "";
  }
  $: A = $media_store[uarA];
  $: B = $media_store[uarB];
  $: if (uarA === uarB) uarB = "";
  function swap() {
    [uarA, uarB] = [uarB, uarA];
    [markA, markB] = [markB, markA];
    proposal = null;
  }

  // the sound of both videos
  $: if (A || B) requestWaveforms([A, B].filter(Boolean), $platform_config_store, $local_file_store);
  $: wA = A && $waveforms[A.UAR];
  $: wB = B && $waveforms[B.UAR];

  // ---- visible window (absolute ms), centred on the red cursor ----
  const spans = [4, 10, 20, 60, 180, 600];
  let span = 20; // seconds
  let center = NaN;
  $: if (Number.isFinite($playback_store.time)) center = $playback_store.time;
  $: if (!Number.isFinite(center) && A) center = A.start.getTime();
  $: w0 = center - (span * 1000) / 2;
  $: w1 = center + (span * 1000) / 2;

  // ---- marks: media time (s) inside each video, so a mark follows its video ----
  let markA = null;
  let markB = null;
  $: absA = A && markA !== null ? A.start.getTime() + markA * 1000 : null;
  $: absB = B && markB !== null ? B.start.getTime() + markB * 1000 : null;

  function videoEl(uar) {
    const el = document.getElementById(uar);
    return el ? el.querySelector("video") : null;
  }
  // mark the frame currently shown by the video (or at the cursor if it is not open)
  function markFrame(which) {
    const m = which === "A" ? A : B;
    if (!m) return;
    const v = videoEl(m.UAR);
    const t = v ? v.currentTime : ($playback_store.time - m.start.getTime()) / 1000;
    if (which === "A") markA = t;
    else markB = t;
  }
  function stepFrame(which, d) {
    const m = which === "A" ? A : B;
    const v = m && videoEl(m.UAR);
    if (v) v.currentTime = Math.max(0, v.currentTime + d);
    else seekTo($playback_store.time + d * 1000);
  }
  function openBoth() {
    const add = [uarA, uarB].filter((u) => u && !$ui_store.media_in_view.includes(u));
    $ui_store.media_in_view = [...$ui_store.media_in_view, ...add];
  }

  // ---- align on the marks ----
  function align() {
    if (absA === null || absB === null || !B) return;
    setSyncOffset(B.UAR, offsetAfterAlign(offsetOf(B), absA, absB));
    proposal = null;
  }

  // ---- automatic: cross-correlation of the sound ----
  let proposal = null; // { lag, score, second, uarA, uarB }
  let auto_msg = "";
  function auto() {
    auto_msg = "";
    proposal = null;
    if (!A || !B || !wA || !wB || wA.status !== "ok" || wB.status !== "ok") {
      auto_msg = "le son des deux vidéos doit être chargé";
      return;
    }
    const a0 = A.start.getTime();
    const bStart = (B.start.getTime() - a0) / 1000;
    let center_lag = 0;
    let search = Math.min(30, Math.max(3, span / 2));
    if (absA !== null && absB !== null) {
      // refine around the marks
      center_lag = (absA - absB) / 1000;
      search = 1.5;
    }
    const r = bestLag(wA.env, wB.env, wA.rate, {
      aStart: 0,
      bStart,
      center: center_lag,
      search,
      window: [(w0 - a0) / 1000, (w1 - a0) / 1000],
    });
    if (!(r.score > 0)) {
      auto_msg = "pas de son commun dans la fenêtre : élargissez-la ou placez le curseur sur un moment fort";
      return;
    }
    proposal = { lag: r.lag, score: r.score, second: r.second, uarA, uarB };
  }
  $: quality = proposal
    ? proposal.score > 0.35 && proposal.score > 1.4 * proposal.second
      ? "nette"
      : proposal.score > 0.2 && proposal.score > 1.15 * proposal.second
      ? "moyenne"
      : "douteuse"
    : "";
  function applyProposal() {
    if (!proposal || !B) return;
    setSyncOffset(B.UAR, offsetOf(B) + proposal.lag);
    proposal = null;
  }

  // ---- drawing ----
  let cA;
  let cB;
  let ruler;
  const x_of = (t, W) => ((t - w0) / (w1 - w0)) * W;
  const t_of = (x, W) => w0 + (x / W) * (w1 - w0);

  function drawStrip(canvas, m, w, mark, otherAbs, color) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, canvas.clientWidth);
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!m) return;
    const s = m.start.getTime();
    const e = new Date(m.end).getTime();
    // extent of the video
    const xs = Math.max(0, x_of(s, W));
    const xe = Math.min(W, x_of(e, W));
    if (xe > xs) {
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(xs, 0, xe - xs, H);
    }
    if (w && w.status === "ok") {
      const from = ((w0 - s) / 1000) * w.rate;
      const to = ((w1 - s) / 1000) * w.rate;
      drawWaveform(g, w.env, { width: W, height: H, color, from, to });
    }
    // the other video's mark (where this one should land)
    if (otherAbs !== null) {
      const x = x_of(otherAbs, W);
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, H);
      g.stroke();
      g.setLineDash([]);
    }
    // this video's mark
    if (mark !== null) {
      const x = x_of(s + mark * 1000, W);
      g.fillStyle = "#ffd400";
      g.fillRect(x - 1, 0, 2, H);
      g.beginPath();
      g.moveTo(x - 5, 0);
      g.lineTo(x + 5, 0);
      g.lineTo(x, 6);
      g.fill();
    }
    // red cursor
    const xp = x_of($playback_store.time, W);
    g.fillStyle = "#ff1a2e";
    g.fillRect(xp - 0.5, 0, 1.5, H);
  }

  function drawRuler() {
    if (!ruler) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, ruler.clientWidth);
    const H = ruler.clientHeight;
    ruler.width = W * dpr;
    ruler.height = H * dpr;
    const g = ruler.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000];
    const step = steps.find((st) => (W / ((w1 - w0) / st)) > 70) || 300000;
    g.fillStyle = "#999";
    g.font = "10px monospace";
    for (let t = Math.ceil(w0 / step) * step; t <= w1; t += step) {
      const x = x_of(t, W);
      g.fillRect(x, 0, 1, 4);
      g.fillText(formatClock(t, step < 1000 ? 1 : 0), x + 2, H - 2);
    }
  }

  $: {
    // redraw on any change
    A, B, wA, wB, markA, markB, w0, w1, $playback_store.time;
    tick().then(() => {
      drawStrip(cA, A, wA, markA, absB, "rgba(255,255,255,0.85)");
      drawStrip(cB, B, wB, markB, absA, "rgba(120,200,255,0.9)");
      drawRuler();
    });
  }

  function clickStrip(e, which) {
    const m = which === "A" ? A : B;
    if (!m) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = t_of(e.clientX - r.left, r.width);
    const media_t = (t - m.start.getTime()) / 1000;
    if (which === "A") markA = media_t;
    else markB = media_t;
  }
  // wheel: move the window (moves the red cursor); ctrl/alt + wheel: zoom
  function wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.altKey) {
      const i = spans.indexOf(span);
      span = spans[Math.max(0, Math.min(spans.length - 1, i + (e.deltaY > 0 ? 1 : -1)))];
    } else {
      const d = (e.deltaX || e.deltaY) / 400;
      seekTo($playback_store.time + d * span * 1000 * 0.25);
    }
  }

  const fmtOff = (x) => (x >= 0 ? "+" : "") + x.toFixed(3) + " s";
  const waveState = (w) =>
    !w ? "" : w.status === "ok" ? "" : w.status === "error" ? "⚠ " + w.error : "son en cours de chargement…";

  let resizeObs;
  let root;
  onMount(() => {
    resizeObs = new ResizeObserver(() => {
      drawStrip(cA, A, wA, markA, absB, "rgba(255,255,255,0.85)");
      drawStrip(cB, B, wB, markB, absA, "rgba(120,200,255,0.9)");
      drawRuler();
    });
    resizeObs.observe(root);
    return () => resizeObs.disconnect();
  });
</script>

<div class="panel" bind:this={root} on:pointerdown|stopPropagation>
  <div class="head">
    <strong>Synchroniser 2 vidéos</strong>
    <span class="help">
      1. maître = ne bouge pas · 2. marquez le <b>même moment</b> dans les deux (clic sur l'onde, ou « repère = image ») · 3. <b>Aligner</b>,
      ou <b>Auto (son)</b>
    </span>
    <button class="close" title="Fermer" on:click={() => ($sync_panel_open = false)}>✕</button>
  </div>

  {#if candidates.length < 2}
    <p class="empty">Il faut au moins deux vidéos avec une heure de captation.</p>
  {:else}
    <div class="rows">
      <!-- master -->
      <div class="row">
        <div class="side">
          <span class="tag master">MAÎTRE</span>
          <select bind:value={uarA} on:change={() => ((markA = null), (proposal = null))}>
            {#each candidates as m}<option value={m.UAR}>{m.UAR}</option>{/each}
          </select>
          {#if A}
            <div class="info">début {formatClock(A.start.getTime(), 3)}</div>
            <div class="btns">
              <button title="Image précédente (1/25 s)" on:click={() => stepFrame("A", -0.04)}>◀</button>
              <button title="Le repère jaune = l'image affichée dans cette vidéo (ou au curseur si elle n'est pas ouverte)" on:click={() => markFrame("A")}
                >repère = image</button
              >
              <button title="Image suivante (1/25 s)" on:click={() => stepFrame("A", 0.04)}>▶</button>
            </div>
            {#if markA !== null}<div class="info mark">repère {formatClock(absA, 3)}</div>{/if}
          {/if}
        </div>
        <div class="stripwrap">
          <canvas bind:this={cA} class="strip" on:click={(e) => clickStrip(e, "A")} on:wheel={wheel} />
          {#if waveState(wA)}<span class="wstate">{waveState(wA)}
              {#if wA.status === "error"}<button on:click={() => retryWaveform(uarA)}>réessayer</button>{/if}</span
            >{/if}
        </div>
      </div>

      <div class="row rulerrow">
        <div class="side">
          <button class="swap" title="Échanger maître et vidéo à décaler" on:click={swap}>⇅ échanger</button>
        </div>
        <canvas bind:this={ruler} class="ruler" on:wheel={wheel} />
      </div>

      <!-- shifted -->
      <div class="row">
        <div class="side">
          <span class="tag moving">À DÉCALER</span>
          <select bind:value={uarB} on:change={() => ((markB = null), (proposal = null))}>
            <option value="" disabled>choisir…</option>
            {#each candidates.filter((m) => m.UAR !== uarA) as m}<option value={m.UAR}>{m.UAR}</option>{/each}
          </select>
          {#if B}
            <div class="info">début {formatClock(B.start.getTime(), 3)} ({fmtOff(offsetOf(B))})</div>
            <div class="btns">
              <button title="Image précédente (1/25 s)" on:click={() => stepFrame("B", -0.04)}>◀</button>
              <button title="Le repère jaune = l'image affichée dans cette vidéo (ou au curseur si elle n'est pas ouverte)" on:click={() => markFrame("B")}
                >repère = image</button
              >
              <button title="Image suivante (1/25 s)" on:click={() => stepFrame("B", 0.04)}>▶</button>
            </div>
            {#if markB !== null}<div class="info mark">repère {formatClock(absB, 3)}</div>{/if}
          {/if}
        </div>
        <div class="stripwrap">
          <canvas bind:this={cB} class="strip" on:click={(e) => clickStrip(e, "B")} on:wheel={wheel} />
          {#if waveState(wB)}<span class="wstate">{waveState(wB)}
              {#if wB.status === "error"}<button on:click={() => retryWaveform(uarB)}>réessayer</button>{/if}</span
            >{/if}
        </div>
      </div>
    </div>

    <div class="actions">
      <label
        >fenêtre
        <select bind:value={span}>
          {#each spans as s}<option value={s}>{s < 60 ? s + " s" : s / 60 + " min"}</option>{/each}
        </select></label
      >
      <button title="Ouvrir les deux vidéos à droite" on:click={openBoth}>ouvrir les vidéos</button>
      <span class="grow" />
      <button
        class="main"
        disabled={absA === null || absB === null || !B}
        title="Décale la vidéo à décaler pour que son repère tombe sur celui du maître"
        on:click={align}
        >Aligner{absA !== null && absB !== null ? ` (${fmtOff((absA - absB) / 1000)})` : ""}</button
      >
      <button
        class="main"
        disabled={!B || !wA || !wB || wA.status !== "ok" || wB.status !== "ok"}
        title={absA !== null && absB !== null
          ? "Affine au son autour des repères (±1,5 s)"
          : "Cherche le décalage qui superpose le mieux les sons dans la fenêtre affichée"}
        on:click={auto}>Auto (son)</button
      >
      <button disabled={!$sync_history.length} title="Annuler la dernière modification de synchro" on:click={undoSync}>↶ annuler</button>
      {#if B && $sync_save[B.UAR]}<span class="msg">{$sync_save[B.UAR]}</span>{/if}
    </div>
    {#if proposal}
      <div class="proposal {quality}">
        Son : décaler <b>{B?.UAR}</b> de <b>{fmtOff(proposal.lag)}</b> — correspondance {quality}
        ({proposal.score.toFixed(2)}, 2e pic {proposal.second.toFixed(2)})
        <button class="main" on:click={applyProposal}>Appliquer</button>
        <button on:click={() => (proposal = null)}>ignorer</button>
      </div>
    {/if}
    {#if auto_msg}<div class="proposal douteuse">{auto_msg}</div>{/if}
  {/if}
</div>

<style>
  .panel {
    background: rgba(0, 0, 0, 0.9);
    color: #ddd;
    font-size: 11px;
    padding: 6px 8px;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .head strong {
    color: white;
    font-size: 12px;
    white-space: nowrap;
  }
  .help {
    color: #999;
    flex: 1 1 auto;
  }
  .help b {
    color: #ddd;
  }
  .close {
    margin-left: auto;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .side {
    width: 170px;
    flex: 0 0 170px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tag {
    font-size: 9px;
    font-weight: bold;
    letter-spacing: 0.05em;
    border-radius: 8px;
    padding: 0 6px;
    align-self: flex-start;
  }
  .tag.master {
    background: white;
    color: black;
  }
  .tag.moving {
    background: #78c8ff;
    color: black;
  }
  .info {
    font-family: monospace;
    color: #aaa;
  }
  .info.mark {
    color: #ffd400;
  }
  .btns {
    display: flex;
    gap: 2px;
  }
  .stripwrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  canvas.strip {
    width: 100%;
    height: 64px;
    display: block;
    background: #0b0b0b;
    border: 1px solid #2a2a2a;
    cursor: crosshair;
  }
  .rulerrow {
    align-items: center;
  }
  canvas.ruler {
    flex: 1 1 auto;
    min-width: 0;
    height: 16px;
  }
  .wstate {
    position: absolute;
    left: 6px;
    top: 4px;
    color: #ffb000;
    pointer-events: auto;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1 1 auto;
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
  select {
    max-width: 170px;
  }
  button.main {
    background: #d90c1e;
    border-color: #d90c1e;
    font-weight: bold;
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .msg {
    color: #999;
  }
  .proposal {
    padding: 3px 6px;
    border-radius: 3px;
    background: #1d2a1d;
  }
  .proposal.moyenne {
    background: #2a271a;
  }
  .proposal.douteuse {
    background: #2a1a1a;
  }
  .empty {
    color: #999;
  }
</style>
