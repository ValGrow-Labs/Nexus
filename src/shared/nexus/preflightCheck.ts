// The preflight comparator (pure). Every container is created, inspected and
// only then started; this function compares the `docker inspect` record with
// the spec main built. Any problem means the container is removed and the
// attempt fails `limits_not_applied`.
//
// Rules: allowlists only, and fail closed. The inspect JSON is untrusted: only
// own data properties of plain objects are read (never an inherited value or a
// getter), a missing, unknown or wrongly typed field is a problem, and the
// function never throws.

import {
  HOME_TMPFS_MB, HOME_TMPFS_PATH, SANDBOX_UID, SANDBOX_USER, TMP_TMPFS_PATH,
  type ContainerSpec, type PreflightObserved, type PreflightReport
} from './execution';
import { looksSecret } from './secretShape';
import { EGRESS_PROXY_ALIAS, egressInternalNetwork, egressOutboundNetwork } from './egressPolicy';

const MAX_TEXT = 512;
const MAX_ITEMS = 64;

type Rec = Record<string, unknown>;
const ABSENT = undefined;

/** A plain object (Object.prototype or null prototype); anything else is not a record. */
function isRec(v: unknown): v is Rec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
/** An own data property, or undefined. Never runs a getter, never reads the prototype chain. */
function own(r: unknown, key: string): unknown {
  if (!isRec(r)) return ABSENT;
  const d = Object.getOwnPropertyDescriptor(r, key);
  return d && 'value' in d ? d.value : ABSENT;
}
/** A plain array with only data elements, or null. */
function list(v: unknown): unknown[] | null {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return null;
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (!d || !('value' in d)) return null;
    out.push(d.value);
  }
  return out;
}
/** Own enumerable data entries of a plain object, or null. */
function entries(v: unknown): [string, unknown][] | null {
  if (!isRec(v)) return null;
  const out: [string, unknown][] = [];
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) return null;
    out.push([k, d.value]);
  }
  return out;
}
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const show = (v: unknown): string => {
  if (v === undefined) return 'unset';
  try { return clip(JSON.stringify(v) ?? String(v)); } catch { return 'unreadable'; }
};
/** `null`, absent and `[]` mean empty; a list of strings is returned; anything else is null (malformed). */
function strList(v: unknown): string[] | null {
  if (v === null || v === undefined) return [];
  const l = list(v);
  if (!l || !l.every((x) => typeof x === 'string')) return null;
  return l as string[];
}
/** Empty when null, absent, `[]` or `{}`; anything else is not empty. */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const l = list(v); if (l) return l.length === 0;
  const e = entries(v); return e !== null && e.length === 0;
}
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const mib = (mb: number): number => mb * 2 ** 20;

function emptyObserved(): PreflightObserved {
  return { nanoCpus: 0, memory: 0, memorySwap: 0, pidsLimit: 0, networkMode: '', readonlyRootfs: false, capDrop: [], capAdd: [],
    privileged: false, user: '', securityOpt: [], mounts: [], portBindings: [], tmpfs: [], devices: [] };
}

function finish(observed: PreflightObserved, problems: string[]): PreflightReport {
  const cut = <T>(xs: T[]): T[] => xs.slice(0, MAX_ITEMS);
  const out: PreflightObserved = {
    ...observed,
    networkMode: clip(observed.networkMode), user: clip(observed.user),
    capDrop: cut(observed.capDrop).map(clip), capAdd: cut(observed.capAdd).map(clip), securityOpt: cut(observed.securityOpt).map(clip),
    mounts: cut(observed.mounts).map((m) => ({ dst: clip(m.dst), rw: m.rw, type: clip(m.type) })),
    portBindings: cut(observed.portBindings).map(clip), tmpfs: cut(observed.tmpfs).map(clip), devices: cut(observed.devices).map(clip)
  };
  const all = problems.length === 0 ? [] : problems;
  const capped = all.length > MAX_ITEMS ? [...all.slice(0, MAX_ITEMS - 1), `and ${all.length - (MAX_ITEMS - 1)} more problems`] : all;
  return { ok: capped.length === 0, observed: out, problems: capped.map(clip) };
}

/** The Docker network name a spec's network mode must produce. */
export function expectedNetworkName(spec: ContainerSpec): string {
  const n = spec.network;
  if (n.mode === 'none') return 'none';
  // An approved install and its proxy: the job's INTERNAL egress network (no route out; B2a stabilization, constraint 5).
  if (n.mode === 'egress-approved' || n.mode === 'egress-proxy') return egressInternalNetwork(String(spec.labels['nexus.job']));
  return n.network;
}

/**
 * The publish network of a dev deployment's forwarder (a spec with `publish` on its service's internal network):
 * `nexus-pub-<jobId>`, beside the internal network. Its published loopback port needs a network that is not
 * `--internal`. Null for every other spec.
 */
export function publishNetworkName(spec: ContainerSpec): string | null {
  if (!spec.publish || spec.network?.mode !== 'service-internal') return null;
  return `nexus-pub-${String(spec.labels['nexus.job']).toLowerCase()}`;
}

/** Every network endpoint a created container of this spec must have, and no other: its network, plus the forwarder's publish network. */
export function expectedEndpoints(spec: ContainerSpec): string[] {
  // The egress proxy alone also joins the job's outbound bridge.
  if (spec.network?.mode === 'egress-proxy') return [expectedNetworkName(spec), egressOutboundNetwork(String(spec.labels['nexus.job']))];
  const pub = publishNetworkName(spec);
  return pub ? [expectedNetworkName(spec), pub] : [expectedNetworkName(spec)];
}

/**
 * The network aliases an egress container must have on each endpoint (null: not checked, e.g. a dev deployment's app,
 * which answers as `app`): the proxy is `nexus-egress-proxy` on the internal network and nothing on the outbound bridge;
 * the install has none (nothing may impersonate the proxy).
 */
export function expectedAliases(spec: ContainerSpec, network: string): string[] | null {
  const mode = spec.network?.mode;
  if (mode === 'egress-proxy') return network === expectedNetworkName(spec) ? [EGRESS_PROXY_ALIAS] : [];
  if (mode === 'egress-approved') return [];
  return null;
}

/** A named volume's `Mode` in `docker inspect`: Docker 29.7.2 reports `z` for `--mount type=volume` and `rw` for compose. */
const VOLUME_MODES: ReadonlySet<string> = new Set(['', 'z', 'Z', 'rw', 'ro']);
const BIND_MODES: ReadonlySet<string> = new Set(['', 'rw', 'ro']);
/** Endpoint fields that are set only once a network endpoint exists (an address, a gateway, an endpoint id). */
const ENDPOINT_FIELDS = ['EndpointID', 'IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway'];

const DESKTOP_HOST = '/run/desktop/mnt/host';

/**
 * A host path in the form Docker Desktop reports as a bind mount's `Source`:
 * `C:\x\y` and `C:/x/y` → `/run/desktop/mnt/host/c/x/y`. A path already in that
 * form, or another absolute POSIX path, is normalised (slashes, no trailing
 * slash, no `.` or `..` segment). Anything else (relative, UNC, a pipe) is null.
 */
export function dockerDesktopHostPath(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return null;
  let posix: string;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) posix = `${DESKTOP_HOST}/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  else if (p.startsWith('/') && !p.startsWith('//')) posix = p;
  else return null;
  const segs = posix.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '.' || s === '..')) return null;
  const desktop = /^\/run\/desktop\/mnt\/host\/([A-Za-z])(\/|$)/.exec(`/${segs.join('/')}`);
  if (desktop) segs[4] = desktop[1].toLowerCase();
  return `/${segs.join('/')}`;
}

/** Sources that must never be mounted, whatever the spec says. */
function forbiddenSource(src: string): string | null {
  const s = src.replace(/\\/g, '/');
  const lower = s.toLowerCase();
  for (const sock of ['/var/run/docker.sock', '/run/docker.sock']) {
    if (s === sock || s.startsWith(`${sock}/`)) return 'the Docker socket';
  }
  if (lower === '//./pipe/docker_engine' || lower.startsWith('//./pipe/docker_engine/') || lower.includes('pipe/docker_engine')) return 'the Docker engine pipe';
  if (s === '/' || s === '') return 'the host root';
  if (s === DESKTOP_HOST || new RegExp(`^${DESKTOP_HOST}/[a-z]/?$`, 'i').test(s)) return 'a whole host drive';
  return null;
}

function tmpfsOptions(spec: ContainerSpec): Record<string, string[]> {
  return {
    [TMP_TMPFS_PATH]: ['rw', 'noexec', 'nosuid', `size=${spec.limits.tmpfsMb}m`, `uid=${SANDBOX_UID}`],
    [HOME_TMPFS_PATH]: ['rw', 'nosuid', `size=${HOME_TMPFS_MB}m`, `uid=${SANDBOX_UID}`]
  };
}
const sameSet = (a: string[], b: string[]): boolean => {
  const sa = new Set(a); const sb = new Set(b);
  return sa.size === a.length && sa.size === sb.size && [...sa].every((x) => sb.has(x));
};
const PINNED_REF = /^(?:[a-z0-9][a-z0-9._\/:-]*@)?sha256:[0-9a-f]{64}$/;
/**
 * An image reference a container may be created from: a local image id `sha256:<64 hex>` (an image Nexus built: the
 * B2a profiles) or `<repository>@sha256:<64 hex>` (an image pulled by digest). A tag never; a name that merely ends in
 * `sha256:<hex>` without the `@` never.
 */
export function isPinnedImageRef(ref: unknown): ref is string { return typeof ref === 'string' && PINNED_REF.test(ref); }
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Compares a `docker inspect` record (an object, or the one-element array the CLI prints) with the spec. Never throws. */
export function comparePreflight(spec: ContainerSpec, inspect: unknown): PreflightReport {
  try {
    return compare(spec, inspect);
  } catch {
    return finish(emptyObserved(), ['docker inspect could not be read']);
  }
}

function compare(spec: ContainerSpec, inspect: unknown): PreflightReport {
  const observed = emptyObserved();
  const problems: string[] = [];
  const arr = list(inspect);
  const record = arr ? (arr.length === 1 ? arr[0] : undefined) : inspect;
  if (!isRec(record)) {
    problems.push(arr && arr.length !== 1 ? `docker inspect returned ${arr.length} records, expected 1` : 'docker inspect returned no container record');
    return finish(observed, problems);
  }
  const cfg = own(record, 'Config');
  const hc = own(record, 'HostConfig');
  if (!isRec(cfg)) problems.push('docker inspect has no readable Config section');
  if (!isRec(hc)) problems.push('docker inspect has no readable HostConfig section');
  const c = (k: string): unknown => own(cfg, k);
  const h = (k: string): unknown => own(hc, k);

  // Image identity: digest-pinned ref, exact local image id
  const ref = spec.image?.ref; const id = spec.image?.id;
  if (typeof ref !== 'string' || !PINNED_REF.test(ref)) problems.push(`image reference ${show(ref)} is not digest-pinned`);
  else if (ref.startsWith('sha256:') && ref !== id) problems.push('image reference is an id that differs from the expected image id');
  if (typeof id !== 'string' || !IMAGE_ID.test(id)) problems.push(`expected image id ${show(id)} is not a sha256 id`);
  if (own(record, 'Image') !== id) problems.push(`image is ${show(own(record, 'Image'))}, expected ${show(id)}`);
  if (c('Image') !== ref) problems.push(`image reference is ${show(c('Image'))}, expected ${show(ref)}`);

  // Command: exactly the entry and the recipe argv
  const entry = strList(c('Entrypoint')); const cmd = strList(c('Cmd'));
  if (entry === null || !Array.isArray(spec.entrypoint) || !sameList(entry, spec.entrypoint)) {
    problems.push(`command entrypoint is ${show(c('Entrypoint'))}, expected ${show(spec.entrypoint)}`);
  }
  if (cmd === null || !Array.isArray(spec.argv) || !sameList(cmd, spec.argv)) problems.push(`command is ${show(c('Cmd'))}, expected ${show(spec.argv)}`);

  // Environment: the spec's pairs exactly, image ENV names on the allowlist, nothing secret-shaped
  const env = strList(c('Env'));
  if (env === null) problems.push('env is unreadable');
  else {
    const seen = new Map<string, string>();
    for (const pair of env) {
      const eq = pair.indexOf('=');
      const name = eq > 0 ? pair.slice(0, eq) : '';
      const value = eq > 0 ? pair.slice(eq + 1) : '';
      if (!ENV_NAME.test(name)) { problems.push(`env entry ${clip(pair.slice(0, 64))} is malformed`); continue; }
      if (seen.has(name)) problems.push(`env ${name} is set twice`);
      seen.set(name, value);
      const inSpec = Object.prototype.hasOwnProperty.call(spec.env ?? {}, name);
      const allowed = Array.isArray(spec.imageEnv) && spec.imageEnv.includes(name);
      if (!inSpec && !allowed) problems.push(`env ${name} is not allowed in this sandbox`);
      if (looksSecret(value)) problems.push(`env ${name} has a secret-shaped value`);
    }
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (!seen.has(name)) problems.push(`env ${name} is missing`);
      else if (seen.get(name) !== value) problems.push(`env ${name} does not have the spec's value`);
    }
  }

  // CPU, memory (no swap), PIDs
  const nanoCpus = num(h('NanoCpus'));
  observed.nanoCpus = nanoCpus ?? 0;
  const wantNano = Math.round(spec.limits.cpus * 1e9);
  if (nanoCpus !== wantNano) problems.push(`cpus limit is ${nanoCpus ? nanoCpus / 1e9 : show(h('NanoCpus'))}, expected ${spec.limits.cpus}`);
  const wantMem = mib(spec.limits.memoryMb);
  const memory = num(h('Memory')); const swap = num(h('MemorySwap'));
  observed.memory = memory ?? 0; observed.memorySwap = swap ?? 0;
  if (memory !== wantMem) problems.push(`memory limit is ${show(h('Memory'))} bytes, expected ${wantMem}`);
  if (swap !== wantMem) problems.push(`memory swap limit is ${show(h('MemorySwap'))} bytes, expected ${wantMem} (no swap)`);
  const oomKill = h('OomKillDisable');
  if (oomKill !== false && oomKill !== null && oomKill !== undefined) problems.push(`memory OOM killer disable is ${show(oomKill)}, expected off`);
  const pids = num(h('PidsLimit'));
  observed.pidsLimit = pids ?? 0;
  if (pids !== spec.limits.pids) problems.push(`pids limit is ${show(h('PidsLimit'))}, expected ${spec.limits.pids}`);

  // Root filesystem, capabilities, privileges
  observed.readonlyRootfs = h('ReadonlyRootfs') === true;
  if (h('ReadonlyRootfs') !== true) problems.push('the read-only root filesystem is not applied');
  const capDrop = strList(h('CapDrop')); const capAdd = strList(h('CapAdd'));
  observed.capDrop = capDrop ?? []; observed.capAdd = capAdd ?? [];
  if (capDrop === null || capDrop.length !== 1 || capDrop[0].toUpperCase() !== 'ALL') problems.push(`capabilities dropped are ${show(h('CapDrop'))}, expected ["ALL"]`);
  if (capAdd === null || capAdd.length > 0) problems.push(`capabilities added: ${show(h('CapAdd'))}, expected none`);
  observed.privileged = h('Privileged') === true;
  if (h('Privileged') !== false) problems.push(h('Privileged') === true ? 'the container is privileged' : `privileged flag is ${show(h('Privileged'))}, expected false`);
  const secOpt = strList(h('SecurityOpt'));
  observed.securityOpt = secOpt ?? [];
  if (secOpt === null || secOpt.length !== 1 || !/^no-new-privileges(?::true|=true)?$/.test(secOpt[0])) {
    if (!(secOpt ?? []).some((o) => /^no-new-privileges(?::true|=true)?$/.test(o))) problems.push('no-new-privileges is not set');
    for (const o of secOpt ?? []) if (!/^no-new-privileges(?::true|=true)?$/.test(o)) problems.push(`security option ${clip(o)} is not allowed`);
    if (secOpt === null) problems.push('security options are unreadable');
    else if (secOpt.filter((o) => /^no-new-privileges(?::true|=true)?$/.test(o)).length > 1) problems.push('security options repeat no-new-privileges');
  }

  // Namespaces: allowlists
  for (const key of ['PidMode', 'UTSMode', 'UsernsMode']) {
    const v = h(key);
    if (v !== '' && v !== undefined) problems.push(`${key} is ${show(v)}, expected the container's own namespace`);
  }
  if (h('IpcMode') !== 'private' && h('IpcMode') !== 'none') problems.push(`IpcMode is ${show(h('IpcMode'))}, expected private or none`);
  if (h('CgroupnsMode') !== 'private' && h('CgroupnsMode') !== '') problems.push(`CgroupnsMode is ${show(h('CgroupnsMode'))}, expected private`);

  // Other host settings
  const restart = h('RestartPolicy');
  const restartName = own(restart, 'Name');
  if (restartName !== 'no' && restartName !== '') problems.push(`restart policy is ${show(restart)}, expected none`);
  if (h('AutoRemove') !== false) problems.push(`auto-remove is ${show(h('AutoRemove'))}, expected false`);
  for (const key of ['GroupAdd', 'Sysctls', 'Ulimits']) if (!isEmpty(h(key))) problems.push(`${key} is ${show(h(key))}, expected none`);
  if (h('Runtime') !== 'runc') problems.push(`runtime is ${show(h('Runtime'))}, expected runc`);
  if (h('CgroupParent') !== '') problems.push(`cgroup parent is ${show(h('CgroupParent'))}, expected the default`);

  // User
  const user = str(c('User'));
  observed.user = user ?? '';
  if (user !== SANDBOX_USER) problems.push(`user is ${user ? clip(user) : 'root (unset)'}, expected ${SANDBOX_USER}`);

  // Network: the mode and exactly the expected endpoints (one; the forwarder also joins its publish network)
  const wantNet = expectedNetworkName(spec);
  const wantAll = expectedEndpoints(spec);
  const netMode = str(h('NetworkMode'));
  observed.networkMode = netMode ?? '';
  if (netMode !== wantNet) problems.push(`network is ${netMode ?? show(h('NetworkMode'))}, expected ${wantNet}`);
  const nets = entries(own(own(record, 'NetworkSettings'), 'Networks'));
  if (nets === null) problems.push('network endpoints are unreadable');
  else {
    const names = nets.map(([k]) => k);
    for (const n of names) if (!wantAll.includes(n)) problems.push(`network endpoint ${clip(n)} is attached, expected only ${wantAll.join(' and ')}`);
    for (const w of wantAll) if (!names.includes(w)) problems.push(`network endpoint ${w} is not attached`);
    for (const [n, ep] of nets) {
      if (ep !== null && ep !== undefined && !isRec(ep)) { problems.push(`network endpoint ${clip(n)} is unreadable`); continue; }
      // No fixed address, link or driver option on any endpoint (main never asks for one).
      for (const f of ['IPAMConfig', 'Links', 'DriverOpts']) if (!isEmpty(own(ep, f))) problems.push(`network endpoint ${clip(n)} has ${f} ${show(own(ep, f))}, expected none`);
      const want = expectedAliases(spec, n);
      if (want !== null) {
        const got = strList(own(ep, 'Aliases'));
        if (got === null || !sameSet(got, want)) problems.push(`network endpoint ${clip(n)} aliases are ${show(own(ep, 'Aliases'))}, expected ${show(want)}`);
      }
    }
    // `none` has no endpoint on a created container: no address, no gateway, no endpoint id.
    if (wantNet === 'none') {
      const none = nets.find(([k]) => k === 'none')?.[1];
      if (none !== undefined && none !== null && !isRec(none)) problems.push('network none is unreadable');
      for (const f of ENDPOINT_FIELDS) {
        const v = own(none, f);
        if (v !== undefined && v !== null && v !== '') problems.push(`network none has an endpoint (${f} is set)`);
      }
    }
  }

  // Name resolution: the container's own /etc/hosts and resolver are Docker's defaults (an added host entry or DNS server
  // could point a registry name, or the proxy's alias, anywhere).
  for (const key of ['ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'Links']) if (!isEmpty(h(key))) problems.push(`${key} is ${show(h(key))}, expected none`);

  // Mounts: exactly the spec's set (destination, source, RW, type, mode, propagation)
  const mounts = list(own(record, 'Mounts'));
  if (mounts === null) problems.push('mounts are unreadable');
  const byDst = new Map<string, Rec>();
  for (const m of mounts ?? []) {
    const dst = str(own(m, 'Destination'));
    if (!isRec(m) || dst === null) { problems.push('a mount has no readable destination'); continue; }
    const rw = own(m, 'RW'); const type = str(own(m, 'Type')) ?? '';
    observed.mounts.push({ dst, rw: rw === true, type });
    if (byDst.has(dst)) problems.push(`mount ${clip(dst)} appears twice`);
    byDst.set(dst, m);
    const src = str(own(m, 'Source'));
    const bad = src === null ? null : forbiddenSource(src);
    if (bad) problems.push(`mount ${clip(dst)} exposes ${bad}`);
    if (typeof rw !== 'boolean') problems.push(`mount ${clip(dst)} RW flag is unreadable`);
    const prop = own(m, 'Propagation');
    if (prop !== undefined && prop !== '' && prop !== 'rprivate') problems.push(`mount ${clip(dst)} propagation ${show(prop)} is not allowed`);
    const mode = own(m, 'Mode');
    if (mode !== undefined && mode !== '') {
      // A named volume may report an SELinux relabel mode (`z`, `Z`) as well; a bind mount only `rw` / `ro`.
      const allowed = type === 'volume' ? VOLUME_MODES : BIND_MODES;
      if (typeof mode !== 'string' || !allowed.has(mode)) problems.push(`mount ${clip(dst)} mode ${show(mode)} is not allowed`);
      else if ((mode === 'rw' || mode === 'ro') && (mode === 'rw') !== (rw === true)) problems.push(`mount ${clip(dst)} mode ${mode} contradicts its RW flag`);
    }
  }
  // A `worktree` mount (an agent turn's session worktree, read-write at /workspace) is allowed only for a container
  // labelled `nexus.kind: 'agent'`, and only read-write: no other container kind gets a read-write bind mount here.
  const isAgentContainer = spec.labels['nexus.kind'] === 'agent';
  const wanted = new Set<string>();
  for (const w of spec.mounts) {
    if (w.kind === 'worktree') {
      if (!isAgentContainer) problems.push(`mount ${clip(w.containerPath)} is a worktree mount outside an agent container`);
      if (w.readOnly) problems.push(`mount ${clip(w.containerPath)} is a read-only worktree mount, expected read-write`);
    }
    wanted.add(w.containerPath);
    const got = byDst.get(w.containerPath);
    if (!got) { problems.push(`mount ${clip(w.containerPath)} is missing`); continue; }
    const hostForm = dockerDesktopHostPath(w.hostPath);
    const wantType = hostForm !== null ? 'bind' : 'volume';
    const type = own(got, 'Type'); const rw = own(got, 'RW');
    if (type !== wantType) problems.push(`mount ${clip(w.containerPath)} is a ${show(type)} mount, expected ${wantType}`);
    if (typeof rw === 'boolean' && rw === w.readOnly) {
      problems.push(`mount ${clip(w.containerPath)} is ${rw ? 'read-write' : 'read-only'}, expected ${w.readOnly ? 'read-only' : 'read-write'}`);
    }
    if (wantType === 'bind') {
      const src = str(own(got, 'Source'));
      const srcForm = src === null ? null : dockerDesktopHostPath(src);
      if (srcForm === null || srcForm !== hostForm) problems.push(`mount ${clip(w.containerPath)} source is ${show(own(got, 'Source'))}, expected ${hostForm}`);
    } else if (own(got, 'Name') !== w.hostPath) {
      problems.push(`mount ${clip(w.containerPath)} volume is ${show(own(got, 'Name'))}, expected ${clip(w.hostPath)}`);
    }
  }
  for (const dst of byDst.keys()) if (!wanted.has(dst)) problems.push(`unexpected mount ${clip(dst)}`);
  if (!isEmpty(h('Binds'))) problems.push(`host binds ${show(h('Binds'))} are present; mounts must come from the spec`);
  if (!isEmpty(h('VolumesFrom'))) problems.push('mounts from other containers are present');

  // Published ports: none, except the forwarder's single loopback binding
  const pb = h('PortBindings');
  const pub = spec.publish;
  const bindings: string[] = [];
  if (isEmpty(pb)) {
    if (pub) problems.push(`port ${pub.containerPort}/tcp is not published on ${pub.hostIp}:${pub.hostPort}`);
  } else {
    const e = entries(pb);
    if (e === null) problems.push('port bindings are unreadable');
    else {
      let matched = 0;
      for (const [port, value] of e) {
        const l = list(value);
        if (!l || l.length === 0) { problems.push(`port ${clip(port)} binding ${show(value)} is not allowed`); continue; }
        for (const b of l) {
          const ip = own(b, 'HostIp'); const hostPort = own(b, 'HostPort');
          bindings.push(`${typeof ip === 'string' && ip ? ip : '0.0.0.0'}:${show(hostPort)}->${port}`);
          const ok = !!pub && ip === pub.hostIp && hostPort === String(pub.hostPort) && port === `${pub.containerPort}/tcp`;
          if (ok) matched++;
          else problems.push(`port ${clip(port)} is published on ${typeof ip === 'string' && ip ? clip(ip) : '0.0.0.0'}:${show(hostPort)}, which the spec does not allow`);
        }
      }
      if (pub && matched !== 1) problems.push(`port ${pub.containerPort}/tcp is not published exactly once on ${pub.hostIp}:${pub.hostPort}`);
    }
  }
  observed.portBindings = bindings;
  const publishAll = h('PublishAllPorts');
  if (publishAll !== false && publishAll !== undefined) problems.push(`all exposed ports are published (${show(publishAll)})`);

  // tmpfs: exactly /tmp and /home/nexus with exact options
  const want = tmpfsOptions(spec);
  const tm = entries(h('Tmpfs'));
  if (tm === null) problems.push(`tmpfs mounts are ${h('Tmpfs') === null || h('Tmpfs') === undefined ? 'missing' : 'unreadable'}`);
  else {
    const got = new Map(tm);
    for (const [path, opts] of tm) {
      observed.tmpfs.push(`${path}:${typeof opts === 'string' ? opts : show(opts)}`);
      if (!Object.prototype.hasOwnProperty.call(want, path)) problems.push(`unexpected tmpfs ${clip(path)}`);
    }
    for (const [path, opts] of Object.entries(want)) {
      const g = got.get(path);
      if (typeof g !== 'string') { problems.push(`tmpfs ${path} is missing`); continue; }
      const parts = g.split(',').map((s) => s.trim()).filter(Boolean);
      if (!sameSet(parts, opts)) problems.push(`tmpfs ${path} options are "${clip(g)}", expected "${opts.join(',')}"`);
    }
  }

  // Devices
  const devices = h('Devices');
  const dl = list(devices);
  if (dl) for (const d of dl) {
    const p = str(own(d, 'PathOnHost')) ?? show(d);
    observed.devices.push(p);
    problems.push(`device ${clip(p)} is passed into the container`);
  } else if (devices !== null && devices !== undefined) problems.push('the device list is unreadable');
  if (!isEmpty(h('DeviceRequests'))) problems.push('device requests (such as GPUs) are present');
  if (!isEmpty(h('DeviceCgroupRules'))) problems.push('device cgroup rules are present');

  // Labels: every spec label present with its exact value (image labels may add others)
  const labels = entries(c('Labels'));
  if (labels === null) problems.push('the container has no readable labels');
  else {
    const got = new Map(labels);
    for (const [key, value] of Object.entries(spec.labels)) {
      if (!got.has(key)) problems.push(`label ${key} is missing`);
      else if (got.get(key) !== value) problems.push(`label ${key} is ${show(got.get(key))}, expected ${show(value)}`);
    }
  }

  return finish(observed, problems);
}
