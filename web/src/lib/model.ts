export type Sample = [elapsedTimeMs: number, forceN: number];
export type Leg = 'left' | 'right';
export type Source = 'device' | 'demo';
export const MAX_SAMPLES = 6000;
export const MAX_DURATION_MS = 300_000;
export interface Run {
  id: string;
  timestamp: string;
  leg: Leg;
  exercise: string;
  durationMs: number;
  sampleRateHz: number;
  peakForceN: number;
  samples: Sample[];
  source: Source;
  stopReason: string;
}
export interface LocalRun extends Run {
  state: 'recording' | 'pending' | 'saved';
  ownerUid: string | null;
}
export interface DeviceStatus {
  type: 'status'; protocol: 1; bootId: number; hostname: string; ip: string;
  uptimeMs: number; adcReady: boolean; calibrated: boolean; hasTare: boolean;
  busy: boolean; otaActive: boolean; otaEnabled: boolean; sampleRateHz: number;
}
export interface DeviceSample {
  type: 'sample'; bootId: number; seq: number; ms: number; raw: number;
  forceN: number | null;
}
export type DeviceMessage = DeviceStatus | DeviceSample |
  { type: 'ack'; id: string; ok: boolean; message: string } |
  { type: 'error'; message: string };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const uint32 = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
export function parseMessage(text: string): DeviceMessage | null {
  if (text.length > 4096) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.type === 'sample' && uint32(d.bootId) && uint32(d.seq) && uint32(d.ms) &&
      finite(d.raw) && (d.forceN === null || finite(d.forceN))) return d as unknown as DeviceSample;
  if (d.type === 'status' && d.protocol === 1 && uint32(d.bootId) && uint32(d.uptimeMs) &&
      typeof d.hostname === 'string' && typeof d.ip === 'string' &&
      ['adcReady', 'calibrated', 'hasTare', 'busy', 'otaActive', 'otaEnabled'].every(k => typeof d[k] === 'boolean') &&
      finite(d.sampleRateHz) && d.sampleRateHz > 0 && d.sampleRateHz <= 100) return d as unknown as DeviceStatus;
  if (d.type === 'ack' && typeof d.id === 'string' && typeof d.ok === 'boolean' && typeof d.message === 'string') return d as unknown as DeviceMessage;
  if (d.type === 'error' && typeof d.message === 'string') return d as unknown as DeviceMessage;
  return null;
}
export function deviceAddress(input: string): { ws: string; status: string } {
  const raw = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`);
  if (!['ws:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter a .local hostname or local IPv4 address, optionally with port 81.');
  }
  const host = url.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every(n => n >= 0 && n <= 255);
  const privateIp = ipv4 && (octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 169 && octets[1] === 254));
  if (!(host === 'localhost' || (host.endsWith('.local') && /^[a-z0-9.-]+$/.test(host)) || privateIp)) {
    throw new Error('Use calf-dyno.local or a private LAN IPv4 address (for example 192.168.1.42).');
  }
  return { ws: `ws://${host}:${url.port || 81}/`, status: `http://${host}/status` };
}
export function validateRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') return false;
  const r = value as Run;
  if (typeof r.id !== 'string' || !/^[\w-]{1,80}$/.test(r.id) || typeof r.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(r.timestamp)) || !['left', 'right'].includes(r.leg) ||
      typeof r.exercise !== 'string' || !r.exercise.length || r.exercise.length > 80 ||
      !finite(r.durationMs) || r.durationMs < 0 || r.durationMs > MAX_DURATION_MS ||
      !finite(r.sampleRateHz) || r.sampleRateHz < 0 || r.sampleRateHz > 1000 ||
      !finite(r.peakForceN) || !['device', 'demo'].includes(r.source) ||
      typeof r.stopReason !== 'string' || r.stopReason.length > 200 ||
      !Array.isArray(r.samples) || !r.samples.length || r.samples.length > MAX_SAMPLES) return false;
  let previous = -1, peak = 0;
  for (const s of r.samples) {
    if (!Array.isArray(s) || s.length !== 2 || !finite(s[0]) || !finite(s[1]) ||
        s[0] < 0 || s[0] <= previous || s[0] > r.durationMs || Math.abs(s[1]) > 1e7) return false;
    previous = s[0]; peak = Math.max(peak, s[1]);
  }
  return Math.abs(peak - r.peakForceN) < 0.001;
}
export class Recorder {
  readonly run: LocalRun;
  private last: DeviceSample;
  private startMs: number;
  constructor(first: DeviceSample, leg: Leg, exercise: string, source: Source, ownerUid: string | null, id: string) {
    this.startMs = first.ms; this.last = first;
    this.run = { id, timestamp: new Date().toISOString(), leg, exercise,
      durationMs: 0, sampleRateHz: 0, peakForceN: 0, samples: [], source,
      stopReason: '', state: 'recording', ownerUid };
  }
  add(sample: DeviceSample): string | null {
    if (sample.forceN === null || !Number.isFinite(sample.forceN) || Math.abs(sample.forceN) > 1e7) return 'Invalid or uncalibrated sample';
    if (sample.bootId !== this.last.bootId) return 'Device restarted';
    const elapsed = (sample.ms - this.startMs) >>> 0;
    if (this.run.samples.length && ((sample.seq - this.last.seq) >>> 0) !== 1) return 'Sample stream interrupted';
    if (elapsed > MAX_DURATION_MS || this.run.samples.length >= MAX_SAMPLES) return 'Recording limit reached';
    if (this.run.samples.length && elapsed <= this.run.durationMs) return 'Device timestamp changed';
    this.run.samples.push([elapsed, sample.forceN]);
    this.run.durationMs = elapsed; this.run.peakForceN = Math.max(this.run.peakForceN, sample.forceN);
    this.last = sample;
    if (this.run.samples.length >= MAX_SAMPLES || elapsed >= MAX_DURATION_MS) return 'Recording limit reached';
    return null;
  }
  finish(reason: string): LocalRun {
    this.run.stopReason = reason.slice(0, 200); this.run.state = 'pending';
    const samples = this.run.samples;
    const span = samples.length > 1 ? samples.at(-1)![0] - samples[0][0] : 0;
    this.run.sampleRateHz = span > 0 ? Math.round((samples.length - 1) * 100_000 / span) / 100 : 0;
    return structuredClone(this.run);
  }
}
// Firestore disallows nested arrays. Use compact maps at the cloud boundary.
export function toCloud(run: Run) {
  if (!validateRun(run)) throw new Error('Run data is invalid. Export a local backup before retrying.');
  const { id: _id, ...rest } = run;
  // Explicit field list avoids sending IndexedDB state/owner metadata.
  return { timestamp: rest.timestamp, leg: rest.leg, exercise: rest.exercise,
    durationMs: rest.durationMs, sampleRateHz: rest.sampleRateHz, peakForceN: rest.peakForceN,
    source: rest.source, stopReason: rest.stopReason, schemaVersion: 1,
    samples: rest.samples.map(([t, f]) => ({ t, f })) };
}
export function fromCloud(id: string, data: Record<string, unknown>): Run {
  if (data.schemaVersion !== 1 || !Array.isArray(data.samples)) throw new Error('Unsupported run format');
  const run = { ...data, id, samples: data.samples.map(s => [s?.t, s?.f]) };
  if (!validateRun(run)) throw new Error('Invalid saved run');
  return run;
}
function csvCell(value: string): string {
  // Neutralize spreadsheet formula injection when opening user-provided labels.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function runCsv(run: Run): string {
  const header = 'run_id,timestamp,leg,exercise,source,elapsed_ms,force_n';
  return [header, ...run.samples.map(([t, f]) =>
    [run.id, run.timestamp, run.leg, run.exercise, run.source].map(csvCell).join(',') + `,${t},${f}`)].join('\r\n') + '\r\n';
}
