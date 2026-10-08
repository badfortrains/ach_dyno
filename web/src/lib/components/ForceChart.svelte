<script lang="ts">
  import type { Sample } from '#lib/model.ts';
  let { samples = [], label = 'Force over time', color = '#246957' }: { samples?: Sample[]; label?: string; color?: string } = $props();
  let width = $state(900);
  const height = 240, left = 56, right = 18, top = 18, bottom = 34;
  let maxTime = $derived(Math.max(5000, samples.at(-1)?.[0] ?? 0));
  let minForce = $derived(Math.min(0, ...samples.map(s => s[1])));
  let maxForce = $derived(Math.max(100, ...samples.map(s => s[1])));
  let range = $derived(maxForce - minForce || 1);
  const x = (t: number) => left + t / maxTime * (width - left - right);
  const y = (f: number) => top + (maxForce - f) / range * (height - top - bottom);
  let points = $derived.by(() => {
    // Preserve each bucket's extrema so brief peaks survive display decimation.
    const result: Sample[] = [];
    const stride = Math.max(1, Math.ceil(samples.length / 450));
    for (let i = 0; i < samples.length; i += stride) {
      const bucket = samples.slice(i, i + stride);
      let low = bucket[0], high = bucket[0];
      for (const s of bucket) { if (s[1] < low[1]) low = s; if (s[1] > high[1]) high = s; }
      result.push(...(low[0] < high[0] ? [low, high] : low[0] > high[0] ? [high, low] : [low]));
    }
    return result.map(([t, f]) => `${x(t)},${y(f)}`).join(' ');
  });
</script>
<div bind:clientWidth={width}>
<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
  <title>{label}</title>
  {#each [0, 1, 2, 3, 4] as tick}
    {@const force = minForce + range * tick / 4}
    <line x1={left} x2={width - right} y1={y(force)} y2={y(force)} stroke="#e4eae5" />
    <text x={left - 12} y={y(force) + 4} text-anchor="end">{force.toFixed(0)}</text>
    <text x={x(maxTime * tick / 4)} y={height - 10} text-anchor="middle">{(maxTime * tick / 4000).toFixed(1)}s</text>
  {/each}
  <text x="14" y="13">N</text>
  {#if samples.length}
    <polyline {points} fill="none" stroke={color} stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
  {:else}
    <text x={width / 2} y="118" text-anchor="middle" class="empty">Your force trace will appear here</text>
  {/if}
</svg>
</div>
<style>
  svg { display: block; width: 100%; overflow: visible; }
  text { font: 11px system-ui, sans-serif; fill: #718178; }
  .empty { font-size: 14px; fill: #89948d; }
</style>
