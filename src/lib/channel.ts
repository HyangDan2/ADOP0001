/**
 * Deployment channel identity (WO-OPS-01A/B).
 *
 * One codebase, two channels: `production` (served at /ADOP0001/) and `beta`
 * (served at /ADOP0001/beta/). The channel is baked in at build time. Production
 * keeps every storage name exactly as it was; beta gets its own namespace so a
 * beta session cannot rewrite production drafts, artifacts or gateway settings.
 * The namespace is a collision guard, not a security boundary.
 */

export type DeploymentChannel = 'production' | 'beta';

function readChannel(): DeploymentChannel {
  return import.meta.env.VITE_ADOP_CHANNEL === 'beta' ? 'beta' : 'production';
}

export const BUILD_CHANNEL: DeploymentChannel = readChannel();
export const IS_BETA_BUILD = BUILD_CHANNEL === 'beta';
export const BUILD_VERSION: string = import.meta.env.VITE_ADOP_VERSION ?? '0.0.0';
export const BUILD_COMMIT: string = import.meta.env.VITE_ADOP_COMMIT ?? 'unknown';
export const BUILD_TIME: string = import.meta.env.VITE_ADOP_BUILD_TIME ?? '';

/** `adop0001.theme` → `adop0001.beta.theme`; production keys never change. */
export function namespaceKey(key: string, channel: DeploymentChannel = BUILD_CHANNEL): string {
  if (channel === 'production') return key;
  const prefix = 'adop0001.';
  return key.startsWith(prefix) ? `${prefix}beta.${key.slice(prefix.length)}` : `${prefix}beta.${key}`;
}

/** `adop0001-drafts` → `adop0001-beta-drafts`; production names never change. */
export function namespaceDbName(name: string, channel: DeploymentChannel = BUILD_CHANNEL): string {
  if (channel === 'production') return name;
  const match = name.match(/^adop0001([-_.])(.*)$/);
  if (!match) return `adop0001-beta-${name}`;
  return `adop0001${match[1]}beta${match[1]}${match[2]}`;
}

export function storageKey(key: string): string {
  return namespaceKey(key);
}

export function databaseName(name: string): string {
  return namespaceDbName(name);
}