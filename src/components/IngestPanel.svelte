<script>
  // Lists the local video files that have no row in the sheet yet, reads their
  // metadata (capture time, GPS, duration) and adds them to the sheet.
  import {
    local_file_store,
    media_store,
    platform_config_store,
    ingest_open,
    sheet_refresh,
  } from "../stores/store";
  import { readerFromFile, readMediaMeta } from "../lib/mediaMeta";
  import { mediaRowFromMeta, uarFromFileName, captureWindow } from "../lib/ingest";
  import { formatLocal } from "../lib/captureTime";
  import { sheetWrite } from "../lib/sheetClient";

  let items = []; // { uar, file, status: "lecture"|"prêt"|"erreur", info, selected }
  let busy = false;
  let message = "";
  let seen = new Set();

  $: unmatched = Object.entries($local_file_store)
    .filter(([uar]) => !$media_store[uar])
    .map(([uar, file]) => ({ uar, file }));

  // analyse files we have not seen yet
  $: for (const { uar, file } of unmatched) {
    if (!seen.has(uar)) {
      seen.add(uar);
      analyse(uar, file);
    }
  }
  // drop items that now exist in the sheet
  $: items = items.filter((it) => !$media_store[it.uar]);

  async function analyse(uar, file) {
    const it = { uar, file, status: "lecture", info: null, selected: true };
    items = [...items, it];
    try {
      const meta = await readMediaMeta(readerFromFile(file));
      it.info = mediaRowFromMeta(meta, $platform_config_store);
      it.status = meta.error ? "erreur" : "prêt";
      if (meta.error) it.error = meta.error;
    } catch (e) {
      it.status = "erreur";
      it.error = String(e);
    }
    items = items;
  }

  async function add_selected() {
    const rows = items.filter((it) => it.selected && it.info).map((it) => it.info.row);
    if (!rows.length) return;
    busy = true;
    message = "";
    try {
      const res = await sheetWrite({ action: "add_media", rows });
      message = `${res.added.length} vidéo(s) ajoutée(s) au sheet` + (res.skipped.length ? `, ${res.skipped.length} déjà présente(s)` : "");
      $sheet_refresh += 1;
    } catch (e) {
      message = "Erreur : " + e.message;
    }
    busy = false;
  }

  const win = () => captureWindow($platform_config_store);
  const fmtWin = () => {
    const w = win();
    return Number.isFinite(w.start) && Number.isFinite(w.end) ? `${formatLocal(w.start)} → ${formatLocal(w.end)}` : "non définie";
  };
  const badge = (it) => {
    const c = it.info?.choice;
    if (!c) return "";
    if (c.status !== "ok") return c.status;
    return c.confidence;
  };
</script>

{#if $ingest_open}
  <div class="backdrop" on:click|self={() => ($ingest_open = false)}>
    <div class="panel box">
      <div class="head">
        <h3>Nouvelles vidéos ({items.length})</h3>
        <button class="close" on:click={() => ($ingest_open = false)}>&#215;</button>
      </div>
      <p class="small">
        Fichiers chargés qui n'ont pas encore de ligne dans le sheet. Heure de captation choisie
        parmi toutes les dates du fichier, dans la fenêtre de l'événement : {fmtWin()}.
      </p>
      {#if items.length === 0}
        <p>Aucune nouvelle vidéo. Utilisez « + vidéos » pour en charger.</p>
      {:else}
        <table>
          <thead>
            <tr><th /><th>UAR</th><th>Captation (heure locale)</th><th>Source / fiabilité</th><th>Position</th><th>Durée</th></tr>
          </thead>
          <tbody>
            {#each items as it (it.uar)}
              <tr class:warn={it.info && (it.info.choice.status !== "ok" || it.info.choice.confidence === "basse")}>
                <td><input type="checkbox" bind:checked={it.selected} disabled={!it.info} /></td>
                <td>
                  {it.uar}
                  {#if it.file.name.lastIndexOf(".") !== it.file.name.indexOf(".")}
                    <div class="note">nom coupé au premier « . » : renommez le fichier</div>
                  {/if}
                </td>
                {#if it.status === "lecture"}
                  <td colspan="4">lecture des métadonnées…</td>
                {:else if it.status === "erreur"}
                  <td colspan="4">illisible : {it.error}</td>
                {:else}
                  <td>
                    {it.info.choice.start_local || "— à chronolocaliser"}
                    <details>
                      <summary>{it.info.choice.candidates.length} date(s) trouvée(s)</summary>
                      <ul>
                        {#each it.info.choice.candidates as c}
                          <li class:chosen={c.source === it.info.choice.source}>
                            {c.local} — {c.label} {c.in_window ? "" : "(hors fenêtre)"}
                          </li>
                        {/each}
                      </ul>
                    </details>
                  </td>
                  <td>
                    <span class="badge {badge(it)}">{badge(it)}</span>
                    {it.info.choice.label || ""}
                    {#each it.info.choice.notes as n}<div class="note">{n}</div>{/each}
                  </td>
                  <td>
                    {#if it.info.meta.location}
                      {it.info.meta.location.lat.toFixed(4)}, {it.info.meta.location.lon.toFixed(4)}
                      {#if it.info.meta.location.accuracy_m}<div class="note">± {Math.round(it.info.meta.location.accuracy_m)} m</div>{/if}
                    {:else}—{/if}
                  </td>
                  <td>{Number.isFinite(it.info.meta.duration) ? it.info.meta.duration.toFixed(1) + " s" : "—"}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="actions">
          <button disabled={busy} on:click={add_selected}>
            {busy ? "Écriture…" : `Ajouter au sheet (${items.filter((i) => i.selected && i.info).length})`}
          </button>
          <span class="small">Les lignes existantes du sheet ne sont jamais modifiées.</span>
        </div>
      {/if}
      {#if message}<p class="message">{message}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .panel {
    background: #111;
    color: white;
    max-width: 1100px;
    width: 92vw;
    max-height: 85vh;
    overflow: auto;
    padding: 12px 16px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .close {
    background: none;
    border: none;
    color: white;
    font-size: 22px;
    cursor: pointer;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 4px 6px;
    border-bottom: 1px solid #333;
  }
  tr.warn {
    background: rgba(217, 12, 30, 0.15);
  }
  .note,
  .small {
    font-size: 11px;
    color: #bbb;
  }
  li.chosen {
    color: #fff;
    font-weight: bold;
  }
  ul {
    margin: 2px 0;
    padding-left: 16px;
    color: #bbb;
  }
  .badge {
    padding: 0 5px;
    border-radius: 3px;
    background: #444;
    margin-right: 4px;
  }
  .badge.haute {
    background: #2d6a3e;
  }
  .badge.moyenne {
    background: #8a6d1d;
  }
  .badge.basse,
  .badge.conflit,
  .badge.hors.fenêtre {
    background: #d90c1e;
  }
  .actions {
    margin-top: 10px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .actions button {
    background: #d90c1e;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 3px;
    cursor: pointer;
  }
  .message {
    margin-top: 8px;
  }
</style>
