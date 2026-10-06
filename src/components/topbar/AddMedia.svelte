<script>
  // "+ vidéos": load more local files at any time, then open the ingest panel.
  import { local_file_store, platform_config_store, ingest_open } from "../../stores/store";
  import { uarFromFileName } from "../../lib/ingest";
  import { sheet_refresh } from "../../stores/store";
  import { parseTrajectoryCsv } from "../../lib/trajImport";
  import { sheetWrite, friendlyError } from "../../lib/sheetClient";
  let input;

  // "trajectoires": import the CSV computed on the Mac (when the script could not write itself)
  let traj_input;
  let traj_msg = "";
  async function on_traj() {
    const files = Array.from(traj_input.files);
    traj_input.value = "";
    let done = 0;
    let fail = 0;
    const errs = [];
    for (const f of files) {
      const { byUar, errors } = parseTrajectoryCsv(await f.text());
      errs.push(...errors.slice(0, 3));
      const uars = Object.keys(byUar);
      for (const [i, uar] of uars.entries()) {
        traj_msg = `trajectoires : ${uar} (${i + 1}/${uars.length})…`;
        try {
          await sheetWrite({ action: "replace_trajectory", uar, rows: byUar[uar] });
          done++;
        } catch (e) {
          fail++;
          errs.push(`${uar} : ${friendlyError(e)}`);
        }
      }
    }
    traj_msg = `trajectoires : ${done} importée(s)` + (fail ? `, ${fail} échec(s)` : "") + (errs.length ? " — " + errs.slice(0, 2).join(" ; ") : "");
    if (done) $sheet_refresh += 1;
    setTimeout(() => (traj_msg = ""), 15000);
  }
  function on_change() {
    for (const f of Array.from(input.files)) $local_file_store[uarFromFileName(f.name)] = f;
    $local_file_store = $local_file_store;
    input.value = "";
    $ingest_open = true;
  }
</script>

{#if ($platform_config_store["Source of media files"] || "").includes("local")}
  <button class="box text_level1 noselect" on:click={() => input.click()}>+ vidéos</button>
  <button class="box text_level1 noselect" on:click={() => ($ingest_open = true)}>nouvelles</button>
  <input type="file" multiple accept="video/*,image/*" bind:this={input} on:change={on_change} />
{/if}
<button
  class="box text_level1 noselect"
  title="Importer les trajectoires calculées sur l'ordinateur (fichier trajectoires_a_importer.csv)"
  on:click={() => traj_input.click()}>trajectoires</button
>
<input type="file" multiple accept=".csv,text/csv" bind:this={traj_input} on:change={on_traj} />
{#if traj_msg}<span class="traj_msg">{traj_msg}</span>{/if}

<style>
  .traj_msg {
    font-size: 11px;
    color: #ccc;
    margin-right: var(--font-size);
    white-space: nowrap;
  }
  input {
    display: none;
  }
  button {
    margin-right: var(--font-size);
    white-space: nowrap;
  }
</style>
