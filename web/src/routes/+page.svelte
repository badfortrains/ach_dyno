<script lang="ts">
  import { onMount } from 'svelte';
  import type { User } from 'firebase/auth';
  import type { QueryDocumentSnapshot } from 'firebase/firestore';
  import { DeviceConnection, type ConnectionState } from '#lib/device.ts';
  import { Recorder, runCsv, type DeviceSample, type DeviceStatus, type Leg, type LocalRun, type Run, type Sample } from '#lib/model.ts';
  import { saveLocal, loadLocal, deleteLocal } from '#lib/storage.ts';
  import ForceChart from '#lib/components/ForceChart.svelte';

  let firebase: typeof import('#lib/firebase.ts') | undefined;
  let user = $state<User | null>(null), authReady = $state(false), authWorking = $state(false);
  let connection = $state<ConnectionState>('disconnected'), connectionDetail = $state('Ready to connect');
  let host = $state('calf-dyno.local'), status = $state<DeviceStatus | null>(null);
  let force = $state<number | null>(null), raw = $state<number | null>(null), lastSampleAt = $state(0);
  let latest: DeviceSample | null = null, device: DeviceConnection;
  let mode = $state<'device' | 'demo'>('device'), demoTimer: ReturnType<typeof setInterval> | undefined;
  let demoSequence = 0, demoStart = 0;
  let leg = $state<Leg>('left'), exercise = $state('seated_plantarflexion');
  let mass = $state(5), commandWorking = $state(false), recording = $state(false), recorder: Recorder | null = null;
  let duration = $state(0), peak = $state(0), runSamples = $state(0), liveSamples = $state<Sample[]>([]);
  let localRuns = $state<LocalRun[]>([]), cloudRuns = $state<Run[]>([]), selected = $state<Run | null>(null);
  let storageReady = $state(false), storageError = $state(''), error = $state(''), notice = $state('');
  let savingId = $state(''), historyBusy = $state(false), historyError = $state(''), hasMore = $state(false);
  let historyCursor: QueryDocumentSnapshot | undefined, authGeneration = 0, mounted = true;
  let filter = $state('all');
  let persistence: Promise<void> = Promise.resolve();
  let lastBackup = 0;
  let visibleLocal = $derived(localRuns.filter(r => r.ownerUid === null || r.ownerUid === user?.uid));
  let allHistoryRuns = $derived.by(() => {
    const all = new Map<string, Run>();
    for (const r of cloudRuns) all.set(r.id, r);
    for (const r of visibleLocal) if (!all.has(r.id) || r.state !== 'saved') all.set(r.id, r);
    return [...all.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  });
  let historyRuns = $derived(allHistoryRuns.filter(r => filter === 'all' || r.leg === filter));
  let pendingCount = $derived(visibleLocal.filter(r => r.state === 'pending' && r.source === 'device').length);
  let currentTrace = $derived(selected ? selected.samples : liveSamples);
  let canRecord = $derived(connection === 'connected' && status?.adcReady && status?.calibrated && !status?.busy && !status?.otaActive &&
    !commandWorking && storageReady && !storageError && force !== null && lastSampleAt > 0 && Date.now() - lastSampleAt < 1500);
  let canTare = $derived(mode === 'device' && connection === 'connected' && status?.adcReady &&
    !status.busy && !status.otaActive && !recording && !commandWorking);
  let calibrationDisabledReason = $derived.by(() => {
    if (mode !== 'device') return 'Use a real device to calibrate; demo measurements are simulated.';
    if (connection !== 'connected') return 'Connect to the dynamometer first.';
    if (!status) return 'Waiting for sensor status…';
    if (status.otaActive) return 'Wait for the firmware update to finish.';
    if (recording) return 'Stop recording before calibrating.';
    if (commandWorking || status.busy) return 'Wait for the sensor operation to finish.';
    if (!status.adcReady) return 'Sensor unavailable. Check its wiring and retry ADC initialization over USB.';
    if (!status.hasTare) return 'First unload the cell and click Zero sensor.';
    if (!Number.isFinite(mass) || mass <= 0 || mass > 10000) return 'Enter a known mass greater than 0 and no more than 10000 kg.';
    return '';
  });
  let latestLeft = $derived(allHistoryRuns.find(r => r.leg === 'left' && r.exercise === exercise && r.source === 'device'));
  let latestRight = $derived(allHistoryRuns.find(r => r.leg === 'right' && r.exercise === exercise && r.source === 'device'));
  const formatExercise = (value: string) => value.replaceAll('_', ' ');
  const dateLabel = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const message = (value: unknown) => value instanceof Error ? value.message : String(value);

  function persist(run: LocalRun): Promise<void> {
    const snapshot = structuredClone($state.snapshot(run));
    const next = persistence.then(() => saveLocal(snapshot));
    // Keep serialization alive after failure while reporting the failed write to its caller.
    persistence = next.catch(() => {});
    return next;
  }
  function updateLocal(run: LocalRun) {
    localRuns = [run, ...localRuns.filter(r => r.id !== run.id)];
  }
  function receiveSample(sample: DeviceSample) {
    if (latest && sample.bootId === latest.bootId && sample.seq === latest.seq) return;
    if (latest && sample.bootId !== latest.bootId && recording) void stopRun('Device restarted');
    latest = sample; lastSampleAt = Date.now(); force = sample.forceN; raw = sample.raw;
    if (recording && recorder) {
      const reason = recorder.add(sample);
      duration = recorder.run.durationMs; peak = recorder.run.peakForceN; runSamples = recorder.run.samples.length;
      liveSamples = [...recorder.run.samples];
      if (reason) { void stopRun(reason); return; }
      if (Date.now() - lastBackup >= 1000) {
        lastBackup = Date.now();
        void persist(recorder.run).catch(e => { storageError = message(e); void stopRun('Local backup failed'); });
      }
    } else {
      if (sample.forceN === null) { liveSamples = []; return; }
      const start = sample.ms - 10_000;
      // Display a rolling ten-second trace; this is independent of recorded raw samples.
      const previous = liveSamples.length ? liveSamples.filter(s => s[0] >= start && s[0] <= sample.ms) : [];
      liveSamples = [...previous, [sample.ms, sample.forceN] as Sample].slice(-1000);
    }
  }
  // Rebase idle chart without changing the recorded sample timestamps.
  let chartSamples = $derived(selected || recording ? currentTrace : currentTrace.map(([t, f]) => [t - (currentTrace[0]?.[0] ?? t), f] as Sample));
  async function startRun() {
    if (!canRecord || !latest || recording || !exercise.trim()) return;
    error = ''; notice = ''; selected = null; duration = 0; peak = 0; runSamples = 0;
    recorder = new Recorder(latest, leg, exercise, mode, mode === 'device' ? user?.uid ?? null : null, crypto.randomUUID());
    recorder.add(latest); liveSamples = [...recorder.run.samples]; recording = true; lastBackup = Date.now();
    try { await persist(recorder.run); } catch (e) { storageError = message(e); await stopRun('Local backup failed'); }
  }
  async function stopRun(reason = 'Stopped by user') {
    if (!recorder || !recording) return;
    const run = recorder.finish(reason); recorder = null; recording = false;
    duration = run.durationMs; peak = run.peakForceN; runSamples = run.samples.length;
    updateLocal(run); selected = run;
    notice = `${reason}. Run kept on this device${run.source === 'demo' ? ' as a demo' : '; save it to your account when ready'}.`;
    try { await persist(run); } catch (e) { storageError = `Local backup failed: ${message(e)}. Export CSV before closing this page.`; }
  }
  function connect() {
    error = ''; selected = null; force = null; status = null; latest = null; liveSamples = [];
    try { localStorage.setItem('dyno-host', host); } catch { /* Local run journal is separate. */ }
    try { device.connect(host); } catch (e) { error = message(e); }
  }
  async function disconnect() {
    await stopRun('Disconnected by user'); device.disconnect(); status = null; force = null; latest = null;
    if (demoTimer) { clearInterval(demoTimer); demoTimer = undefined; }
  }
  async function changeMode(next: 'device' | 'demo') {
    await disconnect(); mode = next; selected = null; liveSamples = [];
    if (next === 'demo') {
      connection = 'connected'; connectionDetail = 'Demo simulator · measurements stay local'; demoStart = Date.now(); demoSequence = 0;
      status = { type: 'status', protocol: 1, bootId: 1, hostname: 'demo', ip: '', uptimeMs: 0, adcReady: true,
        calibrated: true, hasTare: true, busy: false, otaActive: false, otaEnabled: false, sampleRateHz: 20 };
      demoTimer = setInterval(() => {
        const ms = Date.now() - demoStart;
        const forceN = Math.max(0, Math.sin(ms / 1800)) ** 3 * 410 + Math.sin(ms / 131) * 2;
        receiveSample({ type: 'sample', bootId: 1, seq: ++demoSequence, ms, forceN: Math.round(forceN * 100) / 100, raw: 0 });
      }, 50);
    }
  }
  async function sensorCommand(type: 'tare' | 'calibrate') {
    if (mode !== 'device' || recording || commandWorking) return;
    commandWorking = true; error = ''; notice = '';
    try { notice = await device.command(type, type === 'calibrate' ? mass : undefined); }
    catch (e) { error = message(e); } finally { commandWorking = false; }
  }
  async function signIn() {
    if (!firebase) return; authWorking = true; error = '';
    try { await firebase.login(); } catch (e) { error = `Sign-in failed: ${message(e)}. Enable Google sign-in in Firebase and authorize this domain.`; }
    finally { authWorking = false; }
  }
  async function signOut() {
    if (!firebase) return; await stopRun('Account signed out');
    try { await firebase.logout(); } catch (e) { error = message(e); }
  }
  async function fetchHistory(more = false) {
    if (!firebase || !user || historyBusy) return;
    const uid = user.uid, generation = authGeneration;
    historyBusy = true; historyError = '';
    try {
      const result = await firebase.history(uid, more ? historyCursor : undefined);
      if (generation !== authGeneration || !mounted) return;
      cloudRuns = more ? [...cloudRuns, ...result.runs] : result.runs;
      historyCursor = result.cursor; hasMore = result.hasMore;
    } catch (e) { if (generation === authGeneration) historyError = `History unavailable: ${message(e)}`; }
    finally { if (generation === authGeneration) historyBusy = false; }
  }
  async function saveToAccount(run: Run) {
    if (!firebase || !user || savingId || run.source === 'demo') return;
    const uid = user.uid;
    const local = localRuns.find(r => r.id === run.id);
    if (!local || (local.ownerUid !== null && local.ownerUid !== uid)) return;
    savingId = run.id; error = ''; notice = '';
    const claimed: LocalRun = { ...local, ownerUid: uid, state: 'pending' };
    updateLocal(claimed);
    try {
      // Bind to this account BEFORE attempting a cloud write, including ambiguous failures.
      await persist(claimed);
      await firebase.saveRun(uid, claimed);
      const saved: LocalRun = { ...claimed, state: 'saved' };
      await persist(saved); updateLocal(saved);
      if (user?.uid === uid) { notice = 'Run saved to your account.'; await fetchHistory(); }
    } catch (e) { error = `Save not confirmed: ${message(e)}. Your run remains local; retry with the same account.`; }
    finally { savingId = ''; }
  }
  function exportCsv(run: Run) {
    const blob = new Blob([runCsv(run)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `calf-dyno-${run.leg}-${run.timestamp.replaceAll(':', '-')}.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function discard(run: LocalRun) {
    if (savingId || !confirm('Delete this local run and its raw samples? Export CSV first if you need a copy.')) return;
    try { await persistence; await deleteLocal(run.id); localRuns = localRuns.filter(r => r.id !== run.id); if (selected?.id === run.id) selected = null; }
    catch (e) { error = message(e); }
  }
  onMount(() => {
    mounted = true;
    try { host = localStorage.getItem('dyno-host') || host; } catch { /* use default */ }
    device = new DeviceConnection({
      state: (state, detail) => { connection = state; connectionDetail = detail; if (state !== 'connected') { status = null; force = null; latest = null; } },
      interrupted: reason => { void stopRun(reason); },
      message: msg => {
        if (msg.type === 'sample') receiveSample(msg);
        else if (msg.type === 'status') {
          if (recording && (!msg.adcReady || !msg.calibrated || msg.busy || msg.otaActive || (status && msg.bootId !== status.bootId))) void stopRun(msg.otaActive ? 'Firmware update started' : 'Sensor status changed');
          status = msg;
        } else if (msg.type === 'error') { error = msg.message; force = null; latest = null; void stopRun(msg.message); }
      }
    });
    void loadLocal().then(async runs => {
      const recovered = runs.map(r => {
        if (r.state !== 'recording') return r;
        const span = r.samples.at(-1)![0] - r.samples[0][0];
        return { ...r, state: 'pending' as const, stopReason: 'Recovered from last local checkpoint',
          sampleRateHz: span > 0 ? Math.round((r.samples.length - 1) * 100_000 / span) / 100 : 0 };
      });
      localRuns = recovered;
      for (const r of recovered) if (r.stopReason === 'Recovered from last local checkpoint') await persist(r);
      storageReady = true;
    }).catch(e => { storageError = `Local backup unavailable: ${message(e)}. Recording requires browser storage.`; });
    let unsubscribe: (() => void) | undefined;
    void import('#lib/firebase.ts').then(module => {
      if (!mounted) return;
      firebase = module;
      unsubscribe = module.onAuthStateChanged(module.auth, next => {
        if (user?.uid !== next?.uid) { void stopRun('Account changed'); selected = null; }
        user = next; authReady = true; authGeneration++; cloudRuns = []; historyBusy = false; historyError = ''; historyCursor = undefined; hasMore = false;
        if (next) void fetchHistory();
      }, e => { authReady = true; error = message(e); });
    }).catch(e => { authReady = true; error = `Firebase unavailable: ${message(e)}`; });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (recording || storageError) { event.preventDefault(); event.returnValue = ''; } };
    const hidden = () => { if (document.hidden) void stopRun('Page moved to background'); };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('visibilitychange', hidden);
    const staleTimer = setInterval(() => {
      if (mode === 'device' && latest && Date.now() - lastSampleAt > 1500) { force = null; void stopRun('Sensor samples stopped'); }
    }, 500);
    return () => {
      mounted = false; unsubscribe?.(); device.disconnect(); clearInterval(staleTimer); clearInterval(demoTimer);
      window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', hidden);
    };
  });
</script>

<svelte:head>
  <title>Calf Dyno · Strength in progress</title>
  <meta name="description" content="Live calf force measurement and personal strength tracking." />
</svelte:head>

<div class="app-shell">
  <header>
    <a href="/" class="brand" aria-label="Calf Dyno home"><span class="brand-mark">↗</span><span>calf<span class="brand-light">dyno</span><small>STRENGTH IN PROGRESS</small></span></a>
    <div class="account">
      {#if user}<span class="account-name">{user.displayName || user.email}</span><button class="quiet" onclick={signOut} disabled={!!savingId}>Sign out</button>
      {:else}<span class="account-name">Your progress, in one place</span><button class="quiet" onclick={signIn} disabled={!authReady || authWorking}>{authWorking ? 'Signing in…' : 'Sign in with Google'}</button>{/if}
    </div>
  </header>
  <main>
    <div class="page-intro"><div><p class="eyebrow">YOUR MEASUREMENT STUDIO</p><h1>Every rep tells a story.</h1><p>Measure your calf strength. See how far you’ve come.</p></div><span class="session-badge">↗ &nbsp; PLANTARFLEXION</span></div>
    {#if error}<div class="banner error" role="alert">{error}<button aria-label="Dismiss error" onclick={() => error = ''}>×</button></div>{/if}
    {#if storageError}<div class="banner error" role="alert">{storageError}</div>{/if}
    {#if notice}<div class="banner" role="status">{notice}<button aria-label="Dismiss notice" onclick={() => notice = ''}>×</button></div>{/if}
    {#if mode === 'demo'}<div class="banner demo-banner">DEMO MODE · Simulated force. Demo runs stay on this browser and cannot be saved to Firebase.</div>{/if}

    <section class="connection-strip" aria-label="Device connection">
      <div class="connection-heading"><span class:online={connection === 'connected'} class="status-dot"></span><div><strong>{mode === 'demo' ? 'Demo dynamometer' : 'Your dynamometer'}</strong><small>{connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : connection === 'reconnecting' ? 'Reconnecting…' : 'Not connected'}</small></div></div>
      <div class="connection-controls">
        <label class="sr-only" for="host">Device hostname or IP address</label>
        <input id="host" bind:value={host} placeholder="calf-dyno.local" disabled={recording || mode === 'demo' || connection !== 'disconnected'} />
        {#if connection !== 'disconnected'}<button class="quiet" onclick={disconnect}>Disconnect</button>{:else}<button class="primary" onclick={connect} disabled={mode === 'demo'}>Connect device <span>↗</span></button>{/if}
        <button class="text-button" onclick={() => changeMode(mode === 'demo' ? 'device' : 'demo')} disabled={recording}>{mode === 'demo' ? 'Use device' : 'Try demo'}</button>
      </div>
      <p class="connection-detail">{connectionDetail}</p>
    </section>

    <div class="studio-grid">
      <section class="card measurement">
        <div class="card-heading"><p class="eyebrow">LIVE FORCE</p><span class="pill" class:recording>{recording ? '● RECORDING' : status?.calibrated ? `${status.sampleRateHz} Hz · NEWTONS` : 'AWAITING SENSOR'}</span></div>
        <div class="force-display"><span>{force === null ? '—' : force.toFixed(1)}</span><span class="unit">N</span></div>
        <div class="force-footer"><p>{mode === 'demo' ? 'Simulated plantarflexion force' : status && !status.calibrated ? `Calibration required${raw === null ? '' : ` · ${raw} raw counts`}` : 'Current plantarflexion force'}</p><button class="quiet small" onclick={() => sensorCommand('tare')} disabled={!canTare}>{commandWorking ? 'Working…' : '↺ Zero sensor'}</button></div>
        <div class="metric-row"><div><span>PEAK FORCE</span><strong>{(selected?.peakForceN ?? peak).toFixed(1)}<small> N</small></strong></div><div><span>RUN DURATION</span><strong>{((selected?.durationMs ?? duration) / 1000).toFixed(1)}<small> sec</small></strong></div><div><span>SAMPLES</span><strong>{selected?.samples.length ?? runSamples}<small> raw</small></strong></div></div>
        <div class="chart-heading"><strong>{selected ? 'Recorded force trace' : 'Force over time'}</strong><span>{selected ? `${selected.leg} leg · ${dateLabel(selected.timestamp)}` : recording ? 'Recording every sample' : 'Last 10 seconds'}</span>{#if selected}<button class="text-button" onclick={() => selected = null}>Back to live</button>{/if}</div>
        <ForceChart samples={chartSamples} label={selected ? 'Recorded force against elapsed time' : 'Live force against time'} />
        {#if selected}<div class="selected-actions"><span>{selected.stopReason} · {selected.sampleRateHz.toFixed(1)} Hz observed</span><button class="quiet small" onclick={() => exportCsv(selected!)}>↓ Export CSV</button></div>{/if}
      </section>

      <aside class="card run-panel">
        <p class="eyebrow">MAKE A MEASUREMENT</p><h2>Ready when you are.</h2><p class="muted">Choose a leg and exercise, zero the unloaded sensor, then begin your run.</p>
        <fieldset disabled={recording}><legend>Leg</legend><div class="segmented"><button class:active={leg === 'left'} onclick={() => leg = 'left'} aria-pressed={leg === 'left'}>Left leg</button><button class:active={leg === 'right'} onclick={() => leg = 'right'} aria-pressed={leg === 'right'}>Right leg</button></div></fieldset>
        <label for="exercise">Exercise</label><select id="exercise" bind:value={exercise} disabled={recording}><option value="seated_plantarflexion">Seated plantarflexion</option><option value="standing_plantarflexion">Standing plantarflexion</option><option value="isometric_plantarflexion">Isometric plantarflexion</option></select>
        <div class="run-instructions"><span>01</span><p>Set up in the same position each time.</p><span>02</span><p>Build force steadily. Keep the sensor aligned.</p><span>03</span><p>Stop your run to review and save.</p></div>
        {#if recording}<button class="stop full" onclick={() => stopRun()}>■ &nbsp; Stop recording</button>{:else}<button class="primary full" onclick={startRun} disabled={!canRecord}>● &nbsp; Start recording</button>{/if}
        <p class="footnote">{recording ? 'Keep this page open while recording.' : !storageReady ? 'Preparing local backups…' : !status?.calibrated && mode === 'device' ? 'Connect and calibrate the sensor to begin.' : 'Runs are backed up locally. Save to your account after recording.'}</p>
        <details class="calibration">
          <summary>Sensor calibration & connection help</summary>
          <p>1. Unload the cell and click Zero sensor. Hold it still while readings are averaged (about one second).</p>
          <button class="quiet" onclick={() => sensorCommand('tare')} disabled={!canTare}>{commandWorking ? 'Working…' : '↺ Zero sensor'}</button>
          <p>2. Apply a stable, known mass along the measurement axis, enter its weight in kilograms, then calibrate.</p>
          <label for="mass">Known mass (kg)</label>
          <div class="calibration-controls">
            <input id="mass" type="number" min="0.001" max="10000" step="0.1" bind:value={mass} />
            <button class="quiet" onclick={() => sensorCommand('calibrate')} disabled={!!calibrationDisabledReason} aria-describedby="calibration-reason">Calibrate</button>
          </div>
          <p id="calibration-reason" aria-live="polite">{calibrationDisabledReason || 'Ready to calibrate with the known mass applied.'}</p>
          <p>Use Chrome on desktop or Android on the same Wi-Fi. Allow local network access when prompted. If the hostname fails, enter the device IP printed over USB. Firmware allows the ach-dyno Firebase domains and localhost.</p>
          <a href="/connectivity">Open connection test ↗</a>
        </details>
      </aside>
    </div>

    <section class="history-section" aria-label="Measurement history">
      <div class="section-heading"><div><p class="eyebrow">THE BIGGER PICTURE</p><h2>Your strength, over time.</h2></div><div class="history-controls"><label class="sr-only" for="leg-filter">Filter history by leg</label><select id="leg-filter" bind:value={filter}><option value="all">Both legs</option><option value="left">Left leg</option><option value="right">Right leg</option></select>{#if user}<button class="quiet" onclick={() => fetchHistory()} disabled={historyBusy}>{historyBusy ? 'Loading…' : 'Refresh'}</button>{/if}</div></div>
      <div class="comparison-row"><div><span>LATEST LEFT · {formatExercise(exercise)}</span><strong>{latestLeft ? `${latestLeft.peakForceN.toFixed(1)} N` : '—'}</strong></div><div><span>LATEST RIGHT · {formatExercise(exercise)}</span><strong>{latestRight ? `${latestRight.peakForceN.toFixed(1)} N` : '—'}</strong></div><p>Compare runs with the same exercise and setup. These are the most recent measurements in your loaded history.</p></div>
      {#if historyError}<div class="banner error" role="alert">{historyError}<button class="quiet" onclick={() => fetchHistory()}>Retry</button></div>{/if}
      {#if !user}<p class="history-hint">Sign in with Google to save device runs and access your history across devices. {pendingCount ? `${pendingCount} run${pendingCount === 1 ? '' : 's'} ready to save.` : ''}</p>{/if}
      <div class="card history-card">
        {#if historyRuns.length}
          <div class="table-scroll"><table><thead><tr><th>Recorded</th><th>Leg / exercise</th><th>Peak force</th><th>Duration</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>{#each historyRuns as run (run.id)}
            {@const local = visibleLocal.find(r => r.id === run.id)}
            <tr class:selected-row={selected?.id === run.id}><td><button class="run-link" onclick={() => selected = run}>{dateLabel(run.timestamp)}</button></td><td><span class="leg-label">{run.leg}</span><small class="exercise-label">{formatExercise(run.exercise)}</small></td><td class="table-peak">{run.peakForceN.toFixed(1)} <small>N</small></td><td>{(run.durationMs / 1000).toFixed(1)}s</td><td><span class="save-state">{run.source === 'demo' ? 'Demo · local' : local?.state === 'pending' ? 'Local backup' : 'Saved'}</span></td><td><div class="row-actions">{#if run.source === 'device' && local?.state === 'pending'}<button class="quiet small" disabled={!user || !!savingId} onclick={() => saveToAccount(run)}>{savingId === run.id ? 'Saving…' : 'Save'}</button>{/if}<button class="text-button" onclick={() => exportCsv(run)} aria-label={`Export ${run.leg} run as CSV`}>CSV ↓</button>{#if local && local.state !== 'saved'}<button class="text-button" disabled={!!savingId} onclick={() => discard(local)} aria-label="Delete local run">×</button>{/if}</div></td></tr>
          {/each}</tbody></table></div>
        {:else}<div class="history-empty"><span>↗</span><h3>A little progress adds up.</h3><p>{historyBusy ? 'Loading your runs…' : 'Your completed runs will appear here. Start with one measurement.'}</p></div>{/if}
      </div>
      {#if hasMore}<button class="quiet load-more" onclick={() => fetchHistory(true)} disabled={historyBusy}>Load earlier runs</button>{/if}
    </section>
  </main>
  <footer><span>calfdyno <span class="footer-divider">/</span> A clearer view of your progress.</span><span>Local measurement. Personal history.</span></footer>
</div>

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:#f5f6f2;color:#263e34;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px} :global(button),:global(input),:global(select){font:inherit} :global(button){cursor:pointer;transition:background .16s,transform .16s} :global(button:disabled){opacity:.43;cursor:not-allowed} :global(button:focus-visible),:global(a:focus-visible),:global(input:focus-visible),:global(select:focus-visible),:global(summary:focus-visible){outline:3px solid #90af65;outline-offset:3px} :global(a){color:#276953} :global(button){border:0} :global(input),:global(select){border:1px solid #d8e0d8;border-radius:8px;background:#fff;padding:11px 12px;color:#294035;min-width:0} :global(.sr-only){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .app-shell{width:100%;max-width:1440px;margin:auto;padding:0 56px} header{height:100px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dee5dc} .brand{display:flex;gap:12px;align-items:center;font-size:26px;font-weight:750;letter-spacing:-1px;text-decoration:none;color:#244f3f}.brand-mark{display:grid;place-items:center;background:#266550;color:#d2efab;width:43px;height:43px;border-radius:12px;font-size:31px}.brand-light{font-weight:400}.brand small{display:block;font-size:8px;letter-spacing:2px;margin-top:4px;font-weight:600}.account{display:flex;align-items:center;gap:18px}.account-name{color:#6b7a70;font-size:12px}main{padding:38px 0 48px}.page-intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.eyebrow{font-size:10px;letter-spacing:1.9px;font-weight:700;color:#778576;margin:0 0 10px}h1{font-size:38px;font-weight:550;letter-spacing:-1.4px;margin:0 0 10px}h2{font-size:23px;letter-spacing:-.6px;font-weight:550;margin:0 0 12px}.page-intro p:not(.eyebrow){color:#778278;margin:0}.session-badge{font-size:10px;font-weight:700;letter-spacing:1px;background:#eaf0e5;border:1px solid #dbe5d2;padding:11px 14px;border-radius:24px;color:#527044}.quiet{background:#fff;color:#315b45;border:1px solid #d6dfd6;border-radius:8px;padding:10px 15px;font-size:12px;font-weight:600;white-space:nowrap}.quiet:hover:enabled{background:#eef4eb}.primary{background:#286550;color:white;border-radius:8px;padding:12px 18px;font-size:13px;font-weight:600}.primary:hover:enabled{background:#1c503d}.primary span{margin-left:12px}.text-button{background:transparent;color:#5e7866;font-size:12px;padding:8px;white-space:nowrap}.connection-strip{border:1px solid #dce4d9;background:#eef2e9;border-radius:12px;padding:18px 22px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:22px;gap:10px}.connection-heading{display:flex;gap:12px;align-items:center}.connection-heading strong{font-size:13px}.connection-heading small{display:block;color:#7f897d;font-size:11px;margin-top:5px}.status-dot{width:9px;height:9px;border-radius:100%;background:#a6b09e;box-shadow:0 0 0 5px #e2e8da}.status-dot.online{background:#36785b;box-shadow:0 0 0 5px #d8e7d8}.connection-controls{display:flex;gap:10px;align-items:center}.connection-controls input{width:205px;padding:10px 12px;font-size:12px}.connection-detail{width:100%;font-size:11px;color:#6c7b6c;margin:3px 0 0;padding-left:21px;line-height:1.5}.studio-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:22px}.card{background:#fff;border:1px solid #e1e6de;border-radius:14px;box-shadow:0 2px 4px #243c2803}.measurement{min-width:0;padding:26px 28px}.card-heading{display:flex;justify-content:space-between;align-items:center}.card-heading .eyebrow{margin:0}.pill{font-size:9px;font-weight:650;letter-spacing:.7px;padding:6px 9px;background:#f0f4ed;color:#6f8269;border-radius:5px}.pill.recording{background:#fce7e4;color:#a74639}.force-display{display:flex;align-items:baseline;gap:15px;margin:28px 0 8px;line-height:1}.force-display>span:first-child{font-size:90px;font-weight:450;letter-spacing:-5px;font-variant-numeric:tabular-nums}.unit{font-size:23px;color:#869589}.force-footer{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;gap:8px}.force-footer p{color:#89948a;font-size:12px;margin:0}.small{padding:8px 11px;font-size:11px}.metric-row{display:flex;gap:40px;padding:21px 0;border-top:1px solid #edf0e9;border-bottom:1px solid #edf0e9}.metric-row span{display:block;font-size:9px;font-weight:650;color:#8a9689;letter-spacing:1px;margin-bottom:9px}.metric-row strong{font-size:25px;letter-spacing:-.7px;font-weight:500;font-variant-numeric:tabular-nums}.metric-row small{font-size:11px;font-weight:400;color:#8a9689;letter-spacing:0}.chart-heading{display:flex;align-items:center;gap:10px;margin:25px 0 12px}.chart-heading strong{font-size:12px;font-weight:600}.chart-heading>span{font-size:10px;color:#919b90;margin-left:auto}.selected-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;font-size:10px;color:#7c897c}.run-panel{padding:27px 24px}.muted{font-size:12px;color:#7c887c;line-height:1.8;margin:0 0 24px}.run-panel label,legend{display:block;font-size:11px;color:#5e715f;font-weight:650;margin:0 0 10px}.run-panel select{width:100%;font-size:12px}.run-panel fieldset{border:0;padding:0;margin:0 0 22px}.segmented{display:flex;background:#f2f4ee;border-radius:8px;padding:4px}.segmented button{flex:1;background:transparent;padding:10px;border-radius:6px;color:#7d8b7c;font-size:12px}.segmented button.active{background:white;color:#2b654b;box-shadow:0 1px 4px #293e2815;font-weight:650}.run-instructions{display:grid;grid-template-columns:22px 1fr;gap:14px 11px;margin:24px 0}.run-instructions span{border:1px solid #e0e7da;border-radius:50%;height:22px;width:22px;display:grid;place-items:center;font-size:8px;color:#86957c}.run-instructions p{color:#81907b;font-size:11px;line-height:1.6;margin:1px 0 0}.full{width:100%;padding:14px}.stop{background:#a4473e;color:#fff;border-radius:8px}.footnote{font-size:10px;text-align:center;line-height:1.7;color:#929c8d;margin:12px 0 22px}.calibration{border-top:1px solid #e9ede5;padding-top:18px;color:#7f8b78;font-size:11px}.calibration summary{cursor:pointer;color:#5e7259;font-size:11px;line-height:1.7}.calibration p{line-height:1.8}.calibration-controls{display:flex;gap:8px}.calibration-controls input{width:90px}.history-section{margin-top:40px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.section-heading h2{font-size:26px;margin-bottom:0}.history-controls{display:flex;gap:10px}.history-controls select{font-size:12px;background:transparent;padding:9px 12px}.comparison-row{display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:24px;padding:20px 24px;border:1px solid #e0e5da;background:#f0f2e9;border-radius:12px;margin-bottom:17px;align-items:center}.comparison-row span{display:block;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#859079;line-height:1.5}.comparison-row strong{font-size:23px;font-weight:500;display:block;margin-top:8px}.comparison-row p{font-size:11px;color:#829078;line-height:1.8;margin:0}.history-hint{font-size:11px;color:#84917f;margin:0 0 15px}.history-card{min-width:0;width:100%;overflow:hidden}.history-empty{text-align:center;padding:38px 15px 40px}.history-empty>span{display:inline-grid;place-items:center;width:38px;height:38px;background:#f0f4eb;border-radius:50%;color:#7e956a;font-size:23px}.history-empty h3{font-size:16px;font-weight:500;margin:15px 0 9px}.history-empty p{font-size:12px;color:#8b9685;margin:0}.table-scroll{position:relative;max-width:100%;overflow:auto;contain:inline-size}table{border-collapse:collapse;text-align:left;width:100%;font-size:12px;white-space:nowrap}th{background:#fafbf7;font-weight:500;font-size:10px;color:#85917d;padding:15px 20px;border-bottom:1px solid #e9ede4}td{padding:17px 20px;border-bottom:1px solid #eef1e9}.selected-row{background:#f4f8ee}.run-link{padding:0;background:transparent;color:#486547}.run-link:hover{text-decoration:underline}.leg-label{text-transform:capitalize;font-weight:550}.exercise-label{display:block;font-size:10px;margin-top:5px;color:#899382}.table-peak{font-size:17px;color:#345c41;font-weight:500}.table-peak small{font-size:10px;color:#8b9684}.save-state{font-size:10px;color:#7d8c72}.row-actions{display:flex;align-items:center;gap:4px}.load-more{display:block;margin:18px auto 0}.banner{background:#e6f0df;border:1px solid #d6e3cb;color:#496540;padding:13px 16px;border-radius:9px;margin-bottom:16px;font-size:12px;line-height:1.7;display:flex;justify-content:space-between;gap:10px;align-items:center}.banner.error{background:#fff0e9;border-color:#edd5c8;color:#994e36}.banner button{background:transparent;color:inherit;font-size:17px}.demo-banner{font-size:10px;letter-spacing:.7px;background:#fff6d9;border-color:#eadcab;color:#8d772d}footer{border-top:1px solid #e1e6db;display:flex;justify-content:space-between;padding:24px 0;color:#98a08f;font-size:10px}.footer-divider{margin:0 10px;color:#c4ccba}
  @media(min-width:1400px){.app-shell{padding:0 70px}} @media(max-width:1100px){.app-shell{padding:0 30px}.studio-grid{grid-template-columns:minmax(0,1fr) 290px}.measurement{min-width:0;padding:23px}.metric-row{gap:24px}.connection-controls input{width:175px}.account-name{display:none}.force-display>span:first-child{font-size:78px}}
  @media(max-width:800px){.app-shell{padding:0 20px}header{height:80px}.page-intro{align-items:flex-start}.session-badge{display:none}h1{font-size:31px}.studio-grid{grid-template-columns:1fr}.connection-strip{padding:16px}.connection-controls{width:100%;flex-wrap:wrap;margin-top:6px}.connection-controls input{flex:1;min-width:130px}.metric-row{justify-content:space-between}.run-panel{padding:24px}.run-instructions{display:none}.footnote{margin-bottom:15px}.comparison-row{grid-template-columns:1fr 1fr;gap:18px}.comparison-row p{grid-column:1/-1}.force-display>span:first-child{font-size:76px}.section-heading{align-items:flex-start;gap:15px;flex-wrap:wrap}.section-heading h2{font-size:23px}.history-controls{flex-wrap:wrap;justify-content:flex-end}footer{gap:20px;line-height:1.8}footer>span:last-child{display:none}.chart-heading{flex-wrap:wrap}.chart-heading>span{margin-left:0}.selected-actions{align-items:flex-start}.force-footer{flex-wrap:wrap}}
  @media(prefers-reduced-motion:reduce){:global(button){transition:none}}
</style>
