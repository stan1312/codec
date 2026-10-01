<script>
  import { onMount } from "svelte";
  import { playback_store } from "../../stores/store";
  import { togglePlay, seekBy, setRate } from "../../lib/clock";
  import { formatClock } from "../../lib/sync";

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
</div>

<style>
  .transport {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 6px 4px;
    font-size: 12px;
  }

  button,
  select {
    background: #222;
    color: white;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 12px;
    cursor: pointer;
  }

  button.play {
    background: #d90c1e;
    border-color: #d90c1e;
    min-width: 34px;
  }

  .clock {
    margin-left: 8px;
    font-family: monospace;
    font-size: 14px;
    color: white;
  }
</style>
