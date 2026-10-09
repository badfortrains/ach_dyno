<script lang="ts">
  import { onMount } from 'svelte';
  import { deviceAddress, parseMessage } from '#lib/model.ts';
  let host = $state('calf-dyno.local'),
    logs = $state<string[]>([]),
    testing = $state(false),
    connected = $state(false);
  let browserInfo = $state(''),
    socket: WebSocket | undefined,
    controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined,
    generation = 0;
  function log(value: string) {
    logs = [...logs, `${new Date().toLocaleTimeString()} · ${value}`].slice(
      -40,
    );
  }
  function stop() {
    generation++;
    controller?.abort();
    clearTimeout(timeout);
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
    socket = undefined;
    testing = false;
    connected = false;
  }
  async function test() {
    stop();
    logs = [];
    testing = true;
    const token = generation;
    let address;
    try {
      address = deviceAddress(host);
    } catch (e) {
      log(String(e));
      testing = false;
      return;
    }
    log(`Origin: ${location.origin}`);
    log(`HTTP permission probe: ${address.status}`);
    controller = new AbortController();
    const abort = setTimeout(() => controller?.abort(), 5000);
    try {
      const response = await fetch(address.status, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (token !== generation) return;
      log(`HTTP status: ${response.status}`);
      if (response.ok) {
        const status = await response.json();
        log(
          `Device: ${status.hostname}, ADC ${status.adcReady ? 'ready' : 'unavailable'}, calibrated ${status.calibrated}`,
        );
      }
    } catch (e) {
      if (token !== generation) return;
      log(`HTTP probe failed: ${String(e)}. Trying WebSocket.`);
    } finally {
      clearTimeout(abort);
    }
    if (token !== generation) return;
    log(`Opening ${address.ws}`);
    try {
      socket = new WebSocket(address.ws);
      timeout = setTimeout(() => {
        log(
          'Socket timed out. Check LAN, Origin allowlist and Chrome permissions.',
        );
        socket?.close();
        testing = false;
      }, 8000);
      socket.onopen = () => {
        clearTimeout(timeout);
        connected = true;
        testing = false;
        log('WebSocket connected.');
      };
      let samples = 0;
      socket.onmessage = (event) => {
        const msg =
          typeof event.data === 'string' ? parseMessage(event.data) : null;
        if (!msg) {
          log('Invalid protocol message.');
          return;
        }
        if (msg.type === 'status')
          log(
            `Protocol ${msg.protocol}, ${msg.sampleRateHz} Hz, OTA ${msg.otaEnabled ? 'enabled' : 'disabled'}`,
          );
        else if (msg.type === 'sample' && ++samples % 20 === 1)
          log(
            `Sample ${msg.seq}: ${msg.forceN === null ? 'uncalibrated' : `${msg.forceN.toFixed(2)} N`} at ${msg.ms} ms`,
          );
        else if (msg.type === 'error') log(msg.message);
      };
      socket.onerror = () =>
        log(
          'Socket error. Chrome may report additional details in its console.',
        );
      socket.onclose = () => {
        clearTimeout(timeout);
        connected = false;
        testing = false;
        log('Socket closed.');
      };
    } catch (e) {
      testing = false;
      log(`Browser rejected WebSocket: ${String(e)}`);
    }
  }
  onMount(() => {
    browserInfo = navigator.userAgent;
    return stop;
  });
</script>

<svelte:head><title>Calf Dyno · Connection test</title></svelte:head>
<main>
  <a href="/">← Back to dashboard</a>
  <p class="eyebrow">CALF DYNO / CONNECTIVITY SPIKE</p>
  <h1>Test your local connection.</h1>
  <p>
    Use this page from the deployed HTTPS site in Chrome on desktop and Android.
    Keep the ESP8266 on the same Wi-Fi and allow local network access when
    prompted. This tests an HTTP permission probe, the WebSocket handshake, and
    incoming measurements.
  </p>
  <label for="host">Device hostname or LAN IPv4 address</label>
  <div class="controls">
    <input id="host" bind:value={host} disabled={testing || connected} /><button
      onclick={test}
      disabled={testing || connected}
      >{testing ? 'Testing…' : 'Connect & test'}</button
    ><button class="secondary" onclick={stop}>Disconnect</button>
  </div>
  <p class="status" role="status">
    {connected
      ? '● Connected'
      : testing
        ? 'Opening connection…'
        : 'Ready to test'}
  </p>
  <pre aria-label="Connection diagnostics" aria-live="polite">{logs.length
      ? logs.join('\n')
      : 'Connection diagnostics will appear here.'}</pre>
  <details>
    <summary>Troubleshooting & acceptance checks</summary>
    <ul>
      <li>Test calf-dyno.local first, then the IP printed over USB.</li>
      <li>
        Confirm the exact page origin is allowed by firmware. Firebase preview
        channels or custom domains need extra_origins in your private config and
        a firmware rebuild.
      </li>
      <li>
        Check Chrome site settings for local network permission and your
        operating system’s Chrome network permissions.
      </li>
      <li>
        Confirm incoming samples on both desktop and Android from HTTPS. An HTTP
        localhost test alone does not verify mixed-content behavior.
      </li>
      <li>
        If HTTP succeeds but ws:// is blocked as mixed content, this Chrome
        version does not support the required WebSocket exception. Preserve
        diagnostics and try an updated Chrome release; this app does not disable
        browser security.
      </li>
      <li>
        Unplug and reconnect the device; verify the dashboard stops and
        preserves the interrupted run, then reconnects.
      </li>
    </ul>
    <a
      href="https://developer.chrome.com/blog/local-network-access"
      target="_blank"
      rel="noreferrer">Chrome Local Network Access documentation ↗</a
    >
  </details>
  <small>{browserInfo}</small>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f5f6f2;
    color: #263e34;
    font:
      14px system-ui,
      sans-serif;
  }
  main {
    max-width: 850px;
    margin: 50px auto;
    padding: 0 24px;
  }
  a {
    color: #286550;
  }
  .eyebrow {
    font-size: 10px;
    letter-spacing: 2px;
    margin-top: 35px;
    color: #7c8977;
  }
  h1 {
    font-size: 34px;
    font-weight: 550;
    letter-spacing: -1px;
  }
  p {
    line-height: 1.8;
    color: #71816b;
  }
  label {
    display: block;
    margin: 24px 0 10px;
  }
  .controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  input,
  button {
    font: inherit;
    padding: 12px 16px;
    border-radius: 8px;
    border: 1px solid #d8e0d1;
  }
  input {
    flex: 1;
    min-width: 150px;
  }
  button {
    cursor: pointer;
    background: #286550;
    color: white;
  }
  .secondary {
    background: white;
    color: #286550;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .status {
    font-size: 12px;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: #203a2e;
    color: #d0e4c0;
    padding: 24px;
    border-radius: 12px;
    min-height: 170px;
    line-height: 1.8;
    font-size: 12px;
  }
  details {
    background: white;
    padding: 20px;
    border: 1px solid #dce4d4;
    border-radius: 10px;
    line-height: 1.8;
  }
  summary {
    cursor: pointer;
  }
  li {
    margin-bottom: 10px;
  }
  small {
    display: block;
    margin-top: 24px;
    color: #89967f;
    overflow-wrap: anywhere;
  }
  button:focus-visible,
  input:focus-visible,
  a:focus-visible,
  summary:focus-visible {
    outline: 3px solid #90af65;
    outline-offset: 3px;
  }
</style>
