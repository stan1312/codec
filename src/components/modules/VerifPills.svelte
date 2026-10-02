<script>
  // Red / green pills: has the location, the sync and the cone of this video been checked?
  // Click to toggle; saved as checkboxes in the sheet ("Vérif loc", "Vérif sync", "Vérif cône").
  import { VERIF_COLUMNS } from "../../lib/columns";
  import { sheetWrite, friendlyError } from "../../lib/sheetClient";
  import { sheet_refresh } from "../../stores/store";
  export let medium;

  let pending = {}; // column -> value not yet visible in the sheet
  let error = "";

  const truthy = (v) => v === true || String(v).toUpperCase() === "TRUE" || v === "✓";
  $: for (const c of VERIF_COLUMNS) {
    if (c.column in pending && truthy(medium?.[c.column]) === pending[c.column]) {
      delete pending[c.column];
      pending = pending;
    }
  }
  $: value = (c) => (c.column in pending ? pending[c.column] : truthy(medium?.[c.column]));

  async function toggle(c) {
    if (!medium) return;
    const v = !value(c);
    pending = { ...pending, [c.column]: v };
    error = "";
    try {
      await sheetWrite({
        action: "update_media",
        uar: medium.UAR,
        values: { [c.column]: v },
        checkboxes: VERIF_COLUMNS.map((x) => x.column),
      });
      $sheet_refresh += 1;
    } catch (e) {
      error = friendlyError(e);
      const { [c.column]: _, ...rest } = pending;
      pending = rest;
    }
  }
</script>

<span class="pills" on:pointerdown|stopPropagation>
  {#each VERIF_COLUMNS as c}
    <button
      class="pill"
      class:ok={value(c)}
      title={`${c.title} : ${value(c) ? "oui" : "à vérifier"} (cliquer pour changer)`}
      on:click|stopPropagation={() => toggle(c)}>{c.label}</button
    >
  {/each}
  {#if error}<span class="err" title={error}>!</span>{/if}
</span>

<style>
  .pills {
    display: inline-flex;
    gap: 3px;
    margin-left: 6px;
    vertical-align: middle;
  }
  .pill {
    font-size: 10px;
    line-height: 14px;
    text-transform: none;
    padding: 0 7px;
    border-radius: 8px;
    border: 1px solid #ff3b4e;
    background: rgba(217, 12, 30, 0.35);
    color: white;
    cursor: pointer;
  }
  .pill.ok {
    border-color: #3ecf6a;
    background: rgba(46, 160, 80, 0.45);
  }
  .err {
    color: #ff3b4e;
    font-weight: bold;
  }
</style>
