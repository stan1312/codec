<script>
  // "+ vidéos": load more local files at any time, then open the ingest panel.
  import { local_file_store, platform_config_store, ingest_open } from "../../stores/store";
  import { uarFromFileName } from "../../lib/ingest";
  let input;
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

<style>
  input {
    display: none;
  }
  button {
    margin-right: var(--font-size);
  }
</style>
