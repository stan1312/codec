<script>
  // "Synchroniser 2 vidéos": each video has its own player and its own sound
  // (independent of the red cursor). Mark the same moment in both, then
  // "Aligner" — or let "Auto (son)" find the shift. The master never moves;
  // the other video's "Sync offset (s)" is changed (saved to the sheet).
  import { media_store, ui_store } from "../../stores/store";
  import { formatClock, offsetAfterAlign } from "../../lib/sync";
  import { bestLag } from "../../lib/audio";
  import { setSyncOffset, offsetOf, hasChrono, sync_panel_open, sync_save, undoSync, sync_history } from "../../lib/syncEdit";
  import { waveforms } from "../../lib/waveforms";
  import SyncSide from "./SyncSide.svelte";

  $: candidates = Object.values($media_store)
    .filter(hasChrono)
    .sort((a, b) => a.start - b.start);

  // defaults: the two last opened videos
  let uarA = "";
  let uarB = "";
  let inited = false;
  $: if (!inited && candidates.length) {
    const open = $ui_store.media_in_view.filter((u) => candidates.some((m) => m.UAR === u));
    uarA = open[open.length - 2] || open[0] || "";
    uarB = open.length > 1 ? open[open.length - 1] : "";
    inited = true;
  }
  $: A = uarA ? $media_store[uarA] : null;
  $: B = uarB && uarB !== uarA ? $media_store[uarB] : null;

  let markA = null;
  let markB = null;
  let videoA;
  let videoB;
  let proposal = null;
  let msg = "";

  function swap() {
    [uarA, uarB] = [uarB, uarA];
    [markA, markB] = [markB, markA];
    proposal = null;
  }
  const resetA = () => ((markA = null), (proposal = null), (msg = ""));
  const resetB = () => ((markB = null), (proposal = null), (msg = ""));

  // current shift between the two clips: tB = tA + (startA - startB)
  $: rel = A && B ? (A.start.getTime() - B.start.getTime()) / 1000 : 0;

  // ---- align on the marks ----
  $: shift_marks = A && B && markA !== null && markB !== null ? A.start.getTime() + markA * 1000 - (B.start.getTime() + markB * 1000) : null;
  function align() {
    if (shift_marks === null) return;
    setSyncOffset(B.UAR, offsetAfterAlign(offsetOf(B), 0, -shift_marks));
    proposal = null;
    msg = `${B.UAR} décalée de ${fmt(shift_marks / 1000)}`;
  }

  // ---- automatic, by sound ----
  const ranges = [
    [2, "±2 s"],
    [20, "±20 s"],
    [120, "±2 min"],
  ];
  let range = 20;
  $: wA = A && $waveforms[A.UAR];
  $: wB = B && $waveforms[B.UAR];
  $: sound_ok = wA && wB && wA.status === "ok" && wB.status === "ok";
  let busy = false;
  async function auto() {
    msg = "";
    proposal = null;
    if (!sound_ok) return;
    busy = true;
    await new Promise((r) => setTimeout(r, 20)); // let the button show "…"
    let center = 0;
    let search = range;
    if (shift_marks !== null) {
      center = shift_marks / 1000; // refine around the marks
      search = 1.5;
    }
    const r = bestLag(wA.env, wB.env, wA.rate, { aStart: 0, bStart: -rel, center, search });
    busy = false;
    if (!(r.score > 0)) {
      msg = "aucun son commun trouvé : posez un repère dans chaque vidéo ou élargissez la recherche";
      return;
    }
    proposal = { lag: r.lag, score: r.score, second: r.second };
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
    msg = `${B.UAR} décalée de ${fmt(proposal.lag)}`;
    proposal = null;
  }

  // ---- play both together (with the current or the proposed alignment) ----
  function together(extra = 0) {
    if (!videoA || !videoB) return;
    const tA = markA !== null ? Math.max(0, markA - 2) : videoA.currentTime;
    videoA.currentTime = tA;
    videoB.currentTime = Math.max(0, tA + rel - extra);
    videoA.muted = false;
    videoB.muted = true;
    Promise.all([videoA.play(), videoB.play()]).catch(() => {});
  }
  function stopBoth() {
    videoA?.pause();
    videoB?.pause();
  }

  const fmt = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(3) + " s";
</script>

<div class="panel" on:pointerdown|stopPropagation on:keydown|stopPropagation>
  <div class="head">
    <strong>Synchroniser 2 vidéos</strong>
    <span class="help"
      >Les deux lecteurs sont indépendants du curseur rouge. Amenez chaque vidéo sur <b>le même moment</b> (image ou pic de son),
      cliquez <b>📍 marquer</b> des deux côtés, puis <b>Aligner</b>. Ou <b>Auto (son)</b>.</span
    >
    <button class="close" title="Fermer" on:click={() => ($sync_panel_open = false)}>✕</button>
  </div>

  {#if candidates.length < 2}
    <p class="empty">Il faut au moins deux vidéos avec une heure de captation.</p>
  {:else}
    <div class="sides">
      <SyncSide role="master" {candidates} exclude={uarB} bind:uar={uarA} medium={A} bind:mark={markA} bind:video={videoA} on:change={resetA} on:swap={swap} />
      <SyncSide role="moving" {candidates} exclude={uarA} bind:uar={uarB} medium={B} bind:mark={markB} bind:video={videoB} on:change={resetB} />
    </div>

    {#if A && B}
      <div class="actions">
        <span class="state"
          >actuellement : {B.UAR} commence à <b>{formatClock(B.start.getTime(), 3)}</b> ({fmt(offsetOf(B))} de décalage)</span
        >
        <span class="grow" />
        <button
          class="main"
          disabled={shift_marks === null}
          title={shift_marks === null ? "Marquez d'abord le même moment dans les deux vidéos" : "Décale la vidéo de droite pour que les deux repères tombent au même instant"}
          on:click={align}>Aligner les repères{shift_marks !== null ? ` (${fmt(shift_marks / 1000)})` : ""}</button
        >
        <button
          class="main"
          disabled={!sound_ok || busy}
          title={!sound_ok ? "Le son des deux vidéos doit être chargé" : shift_marks !== null ? "Affine au son autour des repères (±1,5 s)" : "Cherche le décalage qui superpose les deux sons"}
          on:click={auto}>{busy ? "recherche…" : "Auto (son)"}</button
        >
        {#if shift_marks === null}
          <select bind:value={range} title="Plage de recherche autour du placement actuel">
            {#each ranges as [v, l]}<option value={v}>{l}</option>{/each}
          </select>
        {/if}
        <button disabled={!videoA || !videoB} title="Lire les deux vidéos ensemble avec le calage actuel (son du maître)" on:click={() => together(0)}
          >▶ lire ensemble</button
        >
        <button disabled={!videoA || !videoB} on:click={stopBoth}>❚❚</button>
        <button disabled={!$sync_history.length} title="Annuler la dernière modification de synchro" on:click={undoSync}>↶ annuler</button>
      </div>
      {#if proposal}
        <div class="proposal {quality}">
          Son : décaler <b>{B.UAR}</b> de <b>{fmt(proposal.lag)}</b> — correspondance <b>{quality}</b>
          <small>({proposal.score.toFixed(2)}, 2e pic {proposal.second.toFixed(2)})</small>
          <button title="Lire les deux vidéos avec ce décalage, sans l'enregistrer" on:click={() => together(proposal.lag)}>▶ essayer</button>
          <button class="main" on:click={applyProposal}>Appliquer</button>
          <button on:click={() => (proposal = null)}>ignorer</button>
        </div>
      {/if}
      {#if msg || $sync_save[B.UAR]}
        <div class="msg">{msg}{msg && $sync_save[B.UAR] ? " — " : ""}{$sync_save[B.UAR] || ""}</div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .panel {
    background: rgba(0, 0, 0, 0.92);
    color: #ddd;
    font-size: 11px;
    padding: 6px 8px;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-sizing: border-box;
    width: 100%;
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
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .state {
    color: #aaa;
  }
  .state b {
    font-family: monospace;
    color: #78c8ff;
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
    padding: 0 6px;
    font-size: 11px;
    line-height: 18px;
    cursor: pointer;
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
  .proposal {
    padding: 4px 6px;
    border-radius: 3px;
    background: #1d2a1d;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .proposal.moyenne {
    background: #2a271a;
  }
  .proposal.douteuse {
    background: #2a1a1a;
  }
  .msg {
    color: #9c9;
  }
  .empty {
    color: #999;
  }
</style>
