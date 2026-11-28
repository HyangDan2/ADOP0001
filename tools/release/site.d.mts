export type SiteChannel = 'production' | 'beta';

export interface ChannelRecord {
  state: 'NONE' | 'DEPLOYED' | 'REMOVED';
  sourceSha: string | null;
  files: Record<string, string>;
  artifactSha256: string;
  deployedAt?: string;
  removedAt?: string;
  lastSourceSha?: string;
}

export interface SiteManifest {
  kind: string;
  updatedAt: string;
  channels: Record<SiteChannel, ChannelRecord>;
  deployments: Array<{
    action: string;
    channel: SiteChannel;
    sourceSha: string | null;
    approvalReference: string | null;
    ciRunId: string | null;
    deployedAt: string;
  }>;
}

export function sha256(data: Uint8Array | string): string;
export function canonicalJson(value: unknown): string;
export function safeRelative(input: string): string;
export function listFiles(root: string): Promise<string[]>;
export function isMetadata(file: string): boolean;
export function channelOf(file: string): SiteChannel | null;
export function hashFiles(root: string, files: string[]): Promise<Record<string, string>>;
export function snapshot(root: string): Promise<Record<SiteChannel, Record<string, string>>>;
export function diffHashes(expected: Record<string, string>, actual: Record<string, string>): string[];
export function emptyManifest(now: string): SiteManifest;
export function readManifest(root: string): Promise<SiteManifest | null>;
export function verifyBaseline(root: string, manifest: SiteManifest | null): Promise<void>;
export function targetFiles(action: string, files: string[]): { channel: SiteChannel; files: string[] };
export function copyTree(from: string, to: string, transform?: (file: string) => string): Promise<void>;
export function assembleSite(options: {
  action: string;
  liveDir: string;
  distDir: string;
  outDir: string;
  sourceSha: string;
  approvalReference: string;
  ciRunId: string;
  now?: string;
}): Promise<{ manifest: SiteManifest; channel: SiteChannel; files: Record<string, string> }>;
export function discoverPaths(text: string, fromUrl: string, baseUrl: string, kind: 'html' | 'css' | 'json'): string[];
export function captureSite(options: {
  baseUrl: string;
  outDir: string;
  extraPaths?: string[];
}): Promise<{ manifest: SiteManifest; files: string[] }>;
export function verifyLive(options: { baseUrl: string; expectedManifest: SiteManifest }): Promise<SiteManifest>;