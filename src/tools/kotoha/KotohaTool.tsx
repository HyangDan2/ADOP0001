import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { EngineDiagnostics } from '../../components/EngineDiagnostics';
import { DOCX_FILE_ACCEPT } from '../../lib/fileKinds';
import { takeFileInput } from '../../lib/fileInput';
import { useOpenedFile } from '../../lib/fileBus';
import { copyText, downloadBlob, sha256Hex } from '../../lib/util';
import { storageKey } from '../../lib/channel';
import { useRequestGate, type RequestHandle } from '../../lib/requestGate';
import { type KotohaOutput } from './adapter';
import { attributeSignature, parseBundleExport, withAttributes, type BundleAttributes, type KotohaBundle, type LossWarning } from './bundle';
import {
  inchToTwips,
  kotohaErrorCode,
  loadDocumentDraft,
  loadLatestBundle,
  kotohaResetEpoch,
  saveDocumentDraft,
  saveDocumentSnapshot,
  clearKotohaDocument,
  storageLabel,
  twipsToInch,
  KOTOHA_LIMITS,
  type KotohaSaveResult,
} from './index';
import { runEngine, ENGINE_VERSION } from '../../engine/core/runner';
import type { EngineDiagnostic } from '../../adapters/types';
import type { ExecutionContext } from '../../engine/core/contracts';
import { HybridAssist } from '../../components/HybridAssist';
import {
  ARTIFACT_SLOTS,
  DOCX_CONTENT_TYPE,
  KOTOHA_MARKDOWN_SLOT_SOURCE,
  kotohaBinaryInputs,
  kotohaDocxContents,
  kotohaMarkdownContents,
} from '../../features/artifacts/tools';
import { useArtifactCapture } from '../../components/artifacts/useArtifactCapture';
import { ArtifactSlotStatus } from '../../components/artifacts/ArtifactStatus';
import {
  NO_ARTIFACT_MESSAGE,
  STALE_INPUT_MESSAGE,
  entryByRole,
  guardCopyText,
  guardExport,
} from '../../components/artifacts/ExportGuard';
import type { ArtifactSlotSnapshot } from '../../lib/artifacts/capture';
const PRESET_KEY = storageKey('adop0001.kotoha.presets');

/** A document with warnings waits here, together with the request that produced it. */
interface PendingApproval {
  output: KotohaOutput;
  request?: RequestHandle;
  context?: ExecutionContext<'kotoha'>;
}

/** The store reports `indexeddb` / `memory`; the UI shows a Japanese label. */
function storageName(storage: 'indexeddb' | 'memory'): string {
  return storage === 'indexeddb' ? 'IndexedDB' : 'メモリ';
}

/**
 * User-facing Japanese explanation for a read/bundle failure. The engine keeps its
 * messages in English; the UI never shows them raw (KOT-004).
 */
const ERROR_LABEL: Record<string, string> = {
  'file-too-large': `ファイルが大きすぎます。上限は ${KOTOHA_LIMITS.maxFileBytes / 1024 / 1024} MB です。`,
  'too-many-entries': `この .docx は中身の部品が多すぎます（上限 ${KOTOHA_LIMITS.maxEntries} 個）。`,
  'entry-too-large': 'この .docx の内部パーツが大きすぎるため、安全のため読み込みを中止しました。',
  'expanded-too-large': 'この .docx を展開すると大きくなりすぎるため、安全のため読み込みを中止しました。',
  'corrupt-zip': 'ファイルが壊れているか、.docx（zip）ではありません。',
  'no-document-xml': 'このファイルには word/document.xml がありません。.docx 文書ではありません。',
  'no-body': 'この文書には本文（w:body）がありません。',
  'bad-bundle': 'この JSON は琴葉のバンドルではありません。',
};

/** A bundle import is a document input, not an engine run; its identity is the parsed bundle. */
async function bundleImportContext(parsed: { bundle: KotohaBundle; markdown: string }): Promise<ExecutionContext<'kotoha'>> {
  const sourceHash = await sha256Hex(parsed.markdown);
  const cacheKey = await sha256Hex(
    JSON.stringify([
      'adop0001.artifact.bundle-import.v1',
      parsed.bundle.fileName,
      sourceHash,
      JSON.stringify(parsed.bundle),
    ]),
  );
  return {
    requestId: `kotoha-import-${parsed.bundle.fileName}`,
    toolId: 'kotoha',
    sourceName: parsed.bundle.fileName,
    sourceHash,
    options: { action: 'decompose', bytes: new Uint8Array(), fileName: parsed.bundle.fileName } as ExecutionContext<'kotoha'>['options'],
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 0,
    cacheKey,
    engineVersion: ENGINE_VERSION,
    cacheHit: false,
  };
}

function explainError(cause: unknown, fallback: string): string {
  const code = kotohaErrorCode(cause);
  if (code && ERROR_LABEL[code]) return ERROR_LABEL[code];
  if (cause instanceof Error && cause.name === 'BundleFormatError') return cause.message;
  return cause instanceof Error ? cause.message : fallback;
}

interface Preset {
  name: string;
  attributes: BundleAttributes;
}

function readPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

function warningSummary(warnings: LossWarning[]): string {
  const total = warnings.reduce((sum, item) => sum + item.count, 0);
  return `原本のまま保持する箇所 ${total} 件`;
}

export function KotohaTool() {
  const [document, setDocument] = useState<{ bundle: KotohaBundle; markdown: string } | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [attributes, setAttributes] = useState<BundleAttributes | null>(null);
  const [output, setOutput] = useState<KotohaOutput | null>(null);
  const [tab, setTab] = useState<'inspector' | 'bundle' | 'markdown-source'>('inspector');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [storage, setStorage] = useState<string>('未保存');
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [presetName, setPresetName] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostic[]>([]);
  /**
   * The markdown and attributes the current `output.docx` was built from
   * (UI-001). Exporting after an edit would otherwise write an older document
   * while the modal announced a fresh one.
   */
  const [docxSource, setDocxSource] = useState<{ markdown: string; attributes: string } | null>(null);
  /** Guards the async draft restore: a user action always wins over a late load. */
  const userTouched = useRef(false);
  /** A reset or adoption invalidates autosaves scheduled for an older document. */
  const documentEpoch = useRef(0);
  /** Only a newer adoption/reset cancels a capture; inspector edits do not. */
  const adoptionEpoch = useRef(0);
  /** FIX-003: a newer file/render/reset supersedes the run in flight. */
  const gate = useRequestGate();
  /** CP03: the two slots are captured independently and never authorize each other. */
  const artifactMd = useArtifactCapture<'kotoha'>(ARTIFACT_SLOTS.kotohaMarkdown);
  const artifactDocx = useArtifactCapture<'kotoha'>(ARTIFACT_SLOTS.kotohaDocx);

  useEffect(() => {
    const resetEpoch = kotohaResetEpoch();
    void loadLatestBundle().then((record) => {
      if (resetEpoch !== kotohaResetEpoch()) return;
      if (record) setStorage(`${new Date(record.savedAt).toLocaleString('ja-JP')} に保存したバンドル · ${storageLabel()}`);
    });
    void loadDocumentDraft().then((draft) => {
      if (resetEpoch !== kotohaResetEpoch() || !draft || !draft.bundle || userTouched.current) return;
      setDocument({ bundle: draft.bundle, markdown: draft.markdown });
      setMarkdown(draft.markdown);
      setAttributes(draft.attributes ?? draft.bundle.attributes);
      setRestored(new Date(draft.savedAt).toLocaleString('ja-JP'));
      setStorage(`下書きを復元しました · ${storageLabel()}`);
    });
  }, []);

  // The draft keeps the edited Markdown, the inspector attributes and the bundle together.
  useEffect(() => {
    if (!document) return;
    const epoch = documentEpoch.current;
    const resetEpoch = kotohaResetEpoch();
    const timer = window.setTimeout(() => {
      if (epoch !== documentEpoch.current || resetEpoch !== kotohaResetEpoch()) return;
      void saveDocumentDraft({
        markdown,
        attributes,
        bundle: withAttributes(document.bundle, attributes),
      }, resetEpoch).then((saved) => {
        if (epoch !== documentEpoch.current || resetEpoch !== kotohaResetEpoch() || saved.superseded) return;
        if (saved.storage === 'memory') setStorage('下書きを保存できませんでした（メモリのみ）');
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [document, markdown, attributes]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  };

  const adopt = async (
    outputValue: KotohaOutput,
    request?: RequestHandle,
    context?: ExecutionContext<'kotoha'>,
  ): Promise<KotohaSaveResult | null> => {
    if (request && !request.isCurrent()) return null;
    const resetEpoch = kotohaResetEpoch();
    const adoption = adoptionEpoch.current + 1;
    adoptionEpoch.current = adoption;
    documentEpoch.current += 1;
    setDocument({ bundle: outputValue.bundle, markdown: outputValue.markdown });
    setMarkdown(outputValue.markdown);
    setAttributes(outputValue.bundle.attributes);
    setOutput(outputValue);
    setElapsed(0);
    setDocxSource(
      outputValue.docx
        ? { markdown: outputValue.markdown, attributes: attributeSignature(outputValue.bundle.attributes) }
        : null,
    );
    setPending(null);
    setRestored(null);
    // The artifact belongs to the adopted output, not to the draft write, and
    // an inspector edit (which cancels the request gate) must not drop it.
    // Only a newer adoption or a reset supersedes the capture.
    if (context) {
      const binaryInputs = await kotohaBinaryInputs(context.options as { bytes?: unknown });
      const isCurrent = () =>
        adoptionEpoch.current === adoption && resetEpoch === kotohaResetEpoch();
      if (isCurrent()) {
        artifactMd.remember(context);
        artifactDocx.remember(context);
        const markdownCaptured = artifactMd.capture({
          contents: kotohaMarkdownContents(outputValue),
          sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(outputValue),
          binaryInputs,
          inputRevision: documentEpoch.current,
          isCurrent,
        });
        if (outputValue.docx) {
          // WO-D05: the .docx revision is derived from the Markdown revision
          // captured for this same adoption, so the edge resolves only after
          // that capture lands.
          artifactDocx.capture({
            contents: kotohaDocxContents(outputValue),
            sourceName: outputValue.fileName,
            binaryInputs,
            inputRevision: documentEpoch.current,
            dependencies: async () => {
              const captured = await markdownCaptured;
              return captured
                ? [
                    {
                      artifactId: captured.artifact!.artifactId,
                      revisionId: captured.revision!.revisionId,
                      relation: 'derived-from' as const,
                    },
                  ]
                : [];
            },
            isCurrent,
          });
        }
      }
    }
    // Latest bundle and working draft commit together, so a reload can never
    // find the new bundle next to the previous document's Markdown (FIX-008).
    const saved = await saveDocumentSnapshot({
      markdown: outputValue.markdown,
      attributes: outputValue.bundle.attributes,
      bundle: outputValue.bundle,
    }, resetEpoch);
    if (request && !request.isCurrent()) return null;
    if (saved.superseded || resetEpoch !== kotohaResetEpoch()) return null;
    setStorage(
      saved.storage === 'indexeddb'
        ? `スタイルバンドルを ${storageName(saved.storage)} に保存 · ${new Date(saved.savedAt).toLocaleTimeString('ja-JP')}`
        : '下書きを保存できませんでした（メモリのみ）',
    );
    return saved;
  };

  /** A document with structural limits is shown to the user *before* it replaces the current work. */
  const offer = async (
    outputValue: KotohaOutput,
    request?: RequestHandle,
    context?: ExecutionContext<'kotoha'>,
  ) => {
    if (outputValue.warnings.length) {
      setPending({ output: outputValue, request, context });
      return;
    }
    await adopt(outputValue, request, context);
  };

  const runSample = async () => {
    const request = gate.start();
    userTouched.current = true;
    setPending(null);
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await runEngine('kotoha', {
        sourceName: 'kotoha-sample.docx',
        source: '',
        options: { action: 'sample' },
        mode: 'local-static',
        signal: request.signal,
      });
      if (!request.isCurrent()) return;
      await adopt(result.output, request, result.context);
      if (!request.isCurrent()) return;
      setDiagnostics(result.diagnostics);
      setElapsed(result.elapsedMs);
      showToast('サンプル .docx を生成して分解しました');
    } catch (cause) {
      if (!request.isCurrent()) return;
      setError(explainError(cause, 'サンプルを生成できませんでした。'));
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  };

  const loadDocx = async (file: File) => {
    const request = gate.start();
    userTouched.current = true;
    setPending(null);
    setError(null);
    setDiagnostics([]);
    if (file.size > KOTOHA_LIMITS.maxFileBytes) {
      // This upload superseded any earlier run; it owns the busy release even
      // though it stops before starting a new engine request (FIX-006).
      gate.invalidate();
      setBusy(false);
      setError(ERROR_LABEL['file-too-large']);
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!request.isCurrent()) return;
      const result = await runEngine('kotoha', {
        sourceName: file.name,
        source: '',
        options: { action: 'decompose', bytes, fileName: file.name },
        mode: 'local-static',
        signal: request.signal,
      });
      if (!request.isCurrent()) return;
      await offer(result.output, request, result.context);
      if (!request.isCurrent()) return;
      setDiagnostics(result.diagnostics);
      setElapsed(result.elapsedMs);
      showToast(`${file.name} を分解しました`);
    } catch (cause) {
      if (!request.isCurrent()) return;
      // The current document is untouched on failure (KOT-004).
      setError(explainError(cause, 'このファイルは .docx 文書として読み取れませんでした。'));
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  };

  const loadBundleFile = async (file: File) => {
    const request = gate.start();
    userTouched.current = true;
    setPending(null);
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    try {
      const parsed = parseBundleExport(await file.text());
      if (!request.isCurrent()) return;
      const saved = await adopt({
        action: 'decompose',
        fileName: parsed.bundle.fileName,
        markdown: parsed.markdown,
        bundle: parsed.bundle,
        warnings: parsed.bundle.warnings ?? [],
      }, request, await bundleImportContext(parsed));
      if (!request.isCurrent() || !saved) return;
      // A failed IndexedDB write stays a failure message: the import succeeded,
      // the persistence did not, and the success text must not overwrite that
      // (PATCH-002).
      setStorage(
        saved.storage === 'indexeddb'
          ? `スタイルバンドルを読み込み、${storageName(saved.storage)} に保存しました`
          : '下書きを保存できませんでした（メモリのみ）',
      );
      showToast('スタイルバンドルを読み込みました');
    } catch (cause) {
      if (!request.isCurrent()) return;
      setError(explainError(cause, 'このファイルは琴葉のバンドルではありません。'));
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  };

  const rebuild = async (download = true) => {
    if (!document || !attributes) return;
    // The run is bound to this snapshot. Any Markdown, inspector or preset edit
    // aborts it, so a late result can never replace the newer document (FIX-005).
    const runMarkdown = markdown;
    const runAttributes = attributes;
    const runBundle = document.bundle;
    const request = gate.start();
    const resetEpoch = kotohaResetEpoch();
    setPending(null);
    setBusy(true);
    setError(null);
    try {
      const result = await runEngine('kotoha', {
        sourceName: runBundle.fileName,
        source: runMarkdown,
        options: {
          action: 'rebuild',
          markdown: runMarkdown,
          bundle: runBundle,
          attributes: runAttributes,
        },
        mode: 'local-static',
        signal: request.signal,
      });
      if (!request.isCurrent()) return;
      // A rebuild only counts as a success when it produced a document; otherwise
      // the UI must say so instead of showing a success toast (UI-001).
      if (!result.output.docx) {
        throw new Error('再構築した .docx を作成できませんでした。');
      }
      documentEpoch.current += 1;
      setOutput(result.output);
      setElapsed(result.elapsedMs);
      setDiagnostics(result.diagnostics);
      // The rebuilt bundle carries the same attributes that were applied
      // (KOT-003). The inspector follows the built artifact, so it can never
      // show values the .docx was not built with (FIX-015).
      setAttributes(result.output.bundle.attributes);
      setDocument({ bundle: result.output.bundle, markdown: runMarkdown });
      setDocxSource({ markdown: runMarkdown, attributes: attributeSignature(result.output.bundle.attributes) });
      const saved = await saveDocumentSnapshot({
        markdown: runMarkdown,
        attributes: result.output.bundle.attributes,
        bundle: result.output.bundle,
      }, resetEpoch);
      if (!request.isCurrent()) return;
      if (saved.superseded || resetEpoch !== kotohaResetEpoch()) return;
      artifactMd.remember(result.context);
      artifactDocx.remember(result.context);
      {
        const isCurrent = () => request.isCurrent() && resetEpoch === kotohaResetEpoch();
        const markdownCaptured = artifactMd.capture({
          contents: kotohaMarkdownContents(result.output),
          sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(result.output),
          inputRevision: documentEpoch.current,
          isCurrent,
        });
        artifactDocx.capture({
          contents: kotohaDocxContents(result.output),
          sourceName: result.output.fileName,
          inputRevision: documentEpoch.current,
          dependencies: async () => {
            const captured = await markdownCaptured;
            return captured
              ? [
                  {
                    artifactId: captured.artifact!.artifactId,
                    revisionId: captured.revision!.revisionId,
                    relation: 'derived-from' as const,
                  },
                ]
              : [];
          },
          isCurrent,
        });
      }
      if (saved.storage === 'memory') setStorage('下書きを保存できませんでした（メモリのみ）');
      if (download) {
        downloadBlob(
          result.output.fileName,
          result.output.docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
      }
      showToast('保持したバンドルで .docx を再構築しました');
    } catch (cause) {
      if (!request.isCurrent()) return;
      setError(explainError(cause, '文書を再構築できませんでした。'));
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  };

  useOpenedFile('kotoha', (opened) => {
    if (/\.docx$/i.test(opened.name)) void loadDocx(opened.file);
    else void loadBundleFile(opened.file);
  });

  const markdownBinding = {
    slot: ARTIFACT_SLOTS.kotohaMarkdown,
    assertCurrent: () => {
      if (!output) throw new Error(NO_ARTIFACT_MESSAGE);
    },
    liveFingerprint: () => artifactMd.liveFingerprint(),
  };

  /**
   * The bundle export merges the inspector's live attributes (KOT-003), so it
   * does not require a rebuilt output. It is still refused when the Markdown on
   * screen no longer matches the stored artifact.
   */
  const bundleBinding = {
    slot: ARTIFACT_SLOTS.kotohaMarkdown,
    assertCurrent: () => {
      if (!document) throw new Error(NO_ARTIFACT_MESSAGE);
    },
    liveFingerprint: () => artifactMd.liveFingerprint(),
  };

  const verifyBundleSnapshot = (snapshot: ArtifactSlotSnapshot) => {
    const primary = snapshot.revision.contents.find((entry) => entry.role === 'primary');
    if (!primary || primary.encoding !== 'utf8' || primary.payload !== markdown) {
      throw new Error(STALE_INPUT_MESSAGE);
    }
  };

  const assertDocxCurrent = () => {
    if (!output?.docx) {
      throw new Error('先に「.docx を再構築」を実行してください。');
    }
    if (
      !docxSource ||
      docxSource.markdown !== markdown ||
      !attributes ||
      docxSource.attributes !== attributeSignature(attributes)
    ) {
      throw new Error('編集内容はまだ .docx に反映されていません。先に「.docx を再構築」を実行してください。');
    }
  };

  const docxBinding = {
    slot: ARTIFACT_SLOTS.kotohaDocx,
    assertCurrent: assertDocxCurrent,
    liveFingerprint: () => artifactDocx.liveFingerprint(),
  };

  const writeDocx = async (fileName: string) => {
    assertDocxCurrent();
    await guardExport(
      docxBinding,
      [
        {
          format: 'docx',
          fileName,
          contentType: DOCX_CONTENT_TYPE,
          entry: entryByRole('primary'),
          payload: () => {
            if (!output?.docx) throw new Error('先に「.docx を再構築」を実行してください。');
            return output.docx;
          },
        },
      ],
      (bytes, name) => downloadBlob(name, bytes, DOCX_CONTENT_TYPE),
    );
  };

  /** Export always merges the inspector's current values into the bundle (KOT-003). */
  const exportBundle = async (base?: string) => {
    if (!document) return;
    bundleBinding.assertCurrent();
    const source = withAttributes(document.bundle, attributes);
    const payload = {
      version: 1,
      tool: 'kotoha',
      exportedAt: new Date().toISOString(),
      markdown,
      bundle: source,
    };
    const text = JSON.stringify(payload, null, 2);
    await guardExport(
      bundleBinding,
      [
        {
          format: 'bundle',
          fileName: `${base ?? document.bundle.fileName.replace(/\.docx$/i, '')}.kotoha.json`,
          contentType: 'application/json',
          entry: entryByRole('style-bundle'),
          payload: () => text,
          derivation: 'rendered',
        },
      ],
      (bytes, name) => downloadBlob(name, bytes, 'application/json;charset=utf-8'),
      { verifySnapshot: verifyBundleSnapshot },
    );
  };

  const resetDocument = async () => {
    gate.invalidate();
    // The document on screen is only discarded once storage confirmed the
    // reset; a refused transaction must not look like a successful reset
    // (PATCH-002).
    const cleared = await clearKotohaDocument();
    if (!cleared.ok) {
      setBusy(false);
      setError('このブラウザの保存領域を初期化できませんでした。文書と下書きは破棄していません。');
      showToast('初期化に失敗しました');
      return;
    }
    documentEpoch.current += 1;
    setBusy(false);
    setDocument(null);
    setMarkdown('');
    setAttributes(null);
    setOutput(null);
    setPending(null);
    setRestored(null);
    setDocxSource(null);
    setError(null);
    setDiagnostics([]);
    setStorage('未保存');
    showToast('この文書と下書きを破棄しました');
  };

  /** Any human edit supersedes an in-flight rebuild; adoption writes bypass this. */
  const beginEdit = () => {
    // The edit starts a new document epoch so an autosave scheduled for the
    // previous text cannot land, and it drops every artifact of the old
    // document: result, rebuilt bytes, diagnostics and a pending approval
    // (PATCH-001).
    documentEpoch.current += 1;
    gate.invalidate();
    setBusy(false);
    setOutput(null);
    setDocxSource(null);
    setDiagnostics([]);
    setPending(null);
  };

  const changeMarkdown = (value: string) => {
    beginEdit();
    setMarkdown(value);
  };

  const savePreset = () => {
    if (!attributes || !presetName.trim()) return;
    const next = [...presets.filter((preset) => preset.name !== presetName.trim()), { name: presetName.trim(), attributes }];
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      showToast('このブラウザにプリセットを保存できませんでした');
    }
    setPresetName('');
    showToast('プリセットを保存しました');
  };

  const stats = document?.bundle.stats;
  const warnings = document?.bundle.warnings ?? [];
  const preservedCount = Object.keys(document?.bundle.preservedBlocks ?? {}).length;
  const attributesReady = Boolean(attributes);

  const update = (patch: Partial<BundleAttributes>) => {
    beginEdit();
    setAttributes((current) => (current ? { ...current, ...patch } : current));
  };

  const pageLabel = useMemo(() => {
    if (!attributes) return '—';
    const width = (attributes.pageWidthTwips / 1440).toFixed(2);
    const height = (attributes.pageHeightTwips / 1440).toFixed(2);
    return `${width}in × ${height}in · ${attributes.orientation === 'landscape' ? '横向き' : '縦向き'}`;
  }, [attributes]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="文書"
          testId="pane-kotoha-document"
          actions={
            <>
              <label className="btn btn-sm">
                ファイルを開く
                <input
                  type="file"
                  accept={DOCX_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  data-testid="kotoha-file"
                  onChange={(event) => {
                    // The picker is cleared before reading so choosing the same
                    // file again (e.g. after cancelling the loss confirmation)
                    // still fires a change event.
                    const file = takeFileInput(event);
                    if (file) void loadDocx(file);
                  }}
                />
              </label>
              <label className="btn btn-sm">
                .kotoha.json を開く
                <input
                  type="file"
                  accept=".json"
                  style={{ display: 'none' }}
                  data-testid="kotoha-bundle-file"
                  onChange={(event) => {
                    const file = takeFileInput(event);
                    if (file) void loadBundleFile(file);
                  }}
                />
              </label>
            </>
          }
          foot={
            <>
              <span>{document?.bundle.fileName ?? '文書が読み込まれていません'}</span>
              <span>{markdown.split('\n').length} 行の Markdown</span>
              <span data-testid="kotoha-storage">{storage}</span>
            </>
          }
        >
          {!document ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <EmptyHint title="サンプルか、お手元の .docx から始めましょう">
                琴葉は文書を Markdown に分解しながら、テンプレートをスタイルバンドルとして保持します。
              </EmptyHint>
              {restored ? (
                <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
                  前回の下書き（{restored}）を復元しました。
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => void runSample()} disabled={busy} data-testid="kotoha-sample">
                  {busy ? <span className="spinner" /> : null} サンプル .docx を生成
                </button>
                <label className="btn">
                  ファイルを開く
                  <input
                    type="file"
                    accept={DOCX_FILE_ACCEPT}
                    style={{ display: 'none' }}
                    data-testid="kotoha-file-empty"
                    onChange={(event) => {
                      const file = takeFileInput(event);
                      if (file) void loadDocx(file);
                    }}
                  />
                </label>
              </div>
              {error ? <p style={{ color: 'var(--danger)', fontSize: 12.5, textAlign: 'center' }}>{error}</p> : null}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void rebuild(true)} disabled={busy || !attributesReady} data-testid="kotoha-rebuild">
                  {busy ? <span className="spinner" /> : null} .docx を再構築
                </button>
                <button type="button" className="btn btn-sm" onClick={() => exportBundle()} data-testid="kotoha-export-bundle">
                  .kotoha.json を出力
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void copyText(markdown).then((ok) => showToast(ok ? 'Markdown をコピーしました' : 'コピーに失敗しました'))}>
                  MD をコピー
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void resetDocument()} data-testid="kotoha-reset">
                  破棄
                </button>
              </div>
              {warnings.length ? (
                <div
                  data-testid="kotoha-warning-banner"
                  style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--warn)', fontSize: 12 }}
                >
                  {warningSummary(warnings)} — インスペクタの「制限事項」で確認できます。
                </div>
              ) : null}
              <LineEditor value={markdown} onChange={changeMarkdown} ariaLabel="Markdown 文書" />
            </div>
          )}
        </ToolPane>

        <ToolPane
          title="テンプレートと往復"
          testId="pane-kotoha-template"
          actions={
            <>
              <div className="tabs" role="tablist" aria-label="テンプレートの表示">
                <button type="button" role="tab" className="tab" aria-selected={tab === 'inspector'} onClick={() => setTab('inspector')}>
                  インスペクタ
                </button>
                <button type="button" role="tab" className="tab" aria-selected={tab === 'bundle'} onClick={() => setTab('bundle')}>
                  バンドル
                </button>
                <button type="button" role="tab" className="tab" aria-selected={tab === 'markdown-source'} onClick={() => setTab('markdown-source')}>
                  MD プレビュー
                </button>
              </div>
              <button type="button" className="btn btn-sm btn-primary" disabled={!document} onClick={() => setExportOpen(true)} data-testid="kotoha-export">
                エクスポート
              </button>
            </>
          }
          foot={
            <>
              <span>{busy ? '処理中…' : output ? `${elapsed} ms で再構築` : 'まだ再構築していません'}</span>
              {output?.docx ? <span>{Math.round(output.docx.length / 1024)} KB .docx</span> : null}
              {stats ? <span>{stats.paragraphs} 段落 · {stats.tables} 表</span> : null}
            </>
          }
        >
          <div className="scroll" data-testid="kotoha-panel">
            {!document || !attributes ? (
              <EmptyHint title="テンプレートが読み込まれていません">文書を読み込むと、保持された OOXML の属性がここに表示されます。</EmptyHint>
            ) : null}

            {document && attributes && tab === 'inspector' ? (
              <div className="inspector">
                <div className="spec-cards">
                  <div className="stat"><b>{stats?.styles ?? 0}</b><span>スタイル</span></div>
                  <div className="stat"><b>{stats?.headers ?? 0}</b><span>ヘッダー</span></div>
                  <div className="stat"><b>{stats?.footers ?? 0}</b><span>フッター</span></div>
                  <div className="stat"><b>{stats?.images ?? 0}</b><span>メディア</span></div>
                  <div className="stat"><b>{stats?.tables ?? 0}</b><span>表</span></div>
                  <div className="stat"><b>{preservedCount}</b><span>原本保持ブロック</span></div>
                </div>

                <div className="inspector-grid">
                  <label className="field">
                    基本フォント
                    <input value={attributes.baseFont} onChange={(event) => update({ baseFont: event.target.value })} data-testid="attr-font" />
                  </label>
                  <label className="field">
                    本文サイズ (pt)
                    <input
                      type="number"
                      step="0.5"
                      min="6"
                      max="30"
                      value={attributes.baseFontSizePt}
                      onChange={(event) => update({ baseFontSizePt: Number(event.target.value) })}
                      data-testid="attr-size"
                    />
                  </label>
                  <label className="field">
                    行間 (×)
                    <input
                      type="number"
                      step="0.05"
                      min="0.8"
                      max="3"
                      value={attributes.lineSpacing}
                      onChange={(event) => update({ lineSpacing: Number(event.target.value) })}
                      data-testid="attr-line"
                    /></label>
                  <label className="field">
                    ページ
                    <input value={pageLabel} readOnly />
                  </label>
                </div>

                <div className="inspector-grid">
                  {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                    <label className="field" key={side}>
                      {({ top: '上', bottom: '下', left: '左', right: '右' } as const)[side]}余白 (in)
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="3"
                        value={twipsToInch(attributes.margins[side])}
                        onChange={(event) =>
                          update({ margins: { ...attributes.margins, [side]: inchToTwips(Number(event.target.value)) } })
                        }
                      />
                    </label>
                  ))}
                </div>

                <div className="inspector-grid">
                  {[1, 2, 3].map((level) => (
                    <label className="field" key={level}>
                      見出し{level}の色
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="color"
                          value={`#${attributes.headingColors[`Heading${level}`] ?? '2D6A4F'}`}
                          onChange={(event) =>
                            update({ headingColors: { ...attributes.headingColors, [`Heading${level}`]: event.target.value.replace('#', '').toUpperCase() } })
                          }
                          style={{ width: 44, height: 30, padding: 2 }}
                        />
                        <input
                          value={`#${attributes.headingColors[`Heading${level}`] ?? '2D6A4F'}`}
                          onChange={(event) =>
                            update({ headingColors: { ...attributes.headingColors, [`Heading${level}`]: event.target.value.replace('#', '').toUpperCase() } })
                          }
                          data-testid={`attr-heading-${level}`}
                        />
                      </span>
                    </label>
                  ))}
                </div>

                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="badge soft">ヘッダー{attributes.headerPreserved ? '保持済み' : 'なし'}</span>
                  <span className="badge soft">フッター{attributes.footerPreserved ? '保持済み' : 'なし'}</span>
                  <span className="badge soft">sectPr の余白を適用</span>
                </div>

                <div style={{ display: 'grid', gap: 6 }} data-testid="kotoha-warnings">
                  <strong style={{ fontSize: 12.5, color: 'var(--ink)' }}>制限事項</strong>
                  {warnings.length === 0 ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>なし — すべてのブロックを Markdown で編集できます。</span>
                  ) : (
                    warnings.map((warning) => (
                      <div key={warning.code} className="check-item">
                        <span className="check-mark">·</span>
                        <span>
                          {warning.labelJa}
                          <span style={{ color: 'var(--muted)' }}> · {warning.count} 件{warning.detail ? ` · ${warning.detail}` : ''}</span>
                        </span>
                      </div>
                    ))
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void rebuild(true)} disabled={busy}>
                    適用して .docx を再構築
                  </button>
                  <input
                    className="btn btn-sm"
                    style={{ background: 'var(--panel-2)', minWidth: 120 }}
                    placeholder="プリセット名"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button type="button" className="btn btn-sm" onClick={savePreset} disabled={!presetName.trim()}>
                    プリセットを保存
                  </button>
                  {presets.length ? (
                    <select
                      className="btn btn-sm"
                      style={{ background: 'var(--panel-2)' }}
                      defaultValue=""
                      onChange={(event) => {
                        const found = presets.find((preset) => preset.name === event.target.value);
                        if (found) {
                          beginEdit();
                          setAttributes(found.attributes);
                        }
                      }}
                    >
                      <option value="">プリセットを読み込む…</option>
                      {presets.map((preset) => (
                        <option key={preset.name} value={preset.name}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                {output?.docx ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="save-state ok">再構築済み: {output.fileName}</span>
                    <span className="badge soft" data-testid="kotoha-roundtrip">
                      原本保持 {output.restoredBlocks ?? 0} ブロック · パーツ {output.restoredParts ?? 0} 件
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void writeDocx(output.fileName)}
                      data-testid="kotoha-download"
                    >
                      .docx をダウンロード
                    </button>
                  </div>
                ) : null}
                {error ? <p style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p> : null}
              </div>
            ) : null}

            {document && tab === 'bundle' ? (
              <div style={{ padding: 14, display: 'grid', gap: 10 }}>
                <div className="spec-cards">
                  <div className="stat"><b>{document.bundle.styles.length}</b><span>スタイルレコード</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.theme).length}</b><span>テーマ要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.headers).length}</b><span>ヘッダー要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.footers).length}</b><span>フッター要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.media).length}</b><span>メディア要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.extraParts ?? {}).length}</b><span>その他パーツ</span></div>
                </div>
                <div className="table-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>スタイル</th>
                        <th>種類</th>
                        <th>フォント</th>
                        <th>サイズ</th>
                        <th>色</th>
                      </tr>
                    </thead>
                    <tbody>
                      {document.bundle.styles.map((style) => (
                        <tr key={style.id}>
                          <td><code>{style.id}</code></td>
                          <td>{style.type}</td>
                          <td>{style.font ?? '—'}</td>
                          <td>{style.sizePt ? `${style.sizePt}pt` : '—'}</td>
                          <td>
                            {style.color ? (
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                <span className="color-dot" style={{ background: `#${style.color}` }} />#{style.color}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => exportBundle()}>
                    .kotoha.json をダウンロード
                  </button>
                </div>
              </div>
            ) : null}

            {document && tab === 'markdown-source' ? (
              <pre className="md-view" data-testid="kotoha-markdown">{markdown}</pre>
            ) : null}
          </div>
        </ToolPane>
      </div>
      <HybridAssist
        toolId="kotoha"
        source={markdown}
        sourceName={output ? output.fileName.replace(/\.docx$/i, '.md') : 'document.md'}
        options={{ action: 'decompose' }}
        localOutput={output}
        onApplied={(next, note) => {
          setMarkdown(next.markdown);
          setOutput(next);
          artifactMd.capture({
            contents: kotohaMarkdownContents(next),
            sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(next),
            inputRevision: documentEpoch.current,
            forceAppend: true,
            isCurrent: () => true,
          });
          showToast(note);
        }}
      />
      <div className="statusbar">
        <span className="dot" /> <span>OOXML エンジン（JSZip）</span>
        <span>{busy ? '処理中' : '待機中'}</span>
        <ArtifactSlotStatus
          slot={ARTIFACT_SLOTS.kotohaMarkdown}
          label="Markdown"
          stale={!output || output.markdown !== markdown}
        />
        <ArtifactSlotStatus
          slot={ARTIFACT_SLOTS.kotohaDocx}
          label="DOCX"
          stale={
            !output?.docx ||
            !docxSource ||
            !attributes ||
            docxSource.markdown !== markdown ||
            docxSource.attributes !== attributeSignature(attributes)
          }
        />
        <span className={error ? 'err' : 'ok'} data-testid="status-message" data-state={error ? 'error' : busy ? 'busy' : 'ok'}>
          {error ? `エラー: ${error}` : busy ? '処理中' : 'エラーなし'}
        </span>
        <EngineDiagnostics diagnostics={diagnostics} />
      </div>
      {toast ? <div className="toast">{toast}</div> : null}

      {pending ? (
        <div className="modal-backdrop" data-testid="kotoha-loss-dialog" role="dialog" aria-modal="true" aria-label="変換前の確認">
          <div className="modal" style={{ width: 'min(620px, 100%)' }}>
            <h2>変換前の確認<span className="jp">原本保持</span></h2>
            <div style={{ display: 'grid', gap: 8 }}>
              <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                Markdown で正確に表せない要素があります。これらは削除せず原本の OOXML のまま保持し、再構築時にその位置へ戻します（編集はできません）。
              </p>
              {pending.output.warnings.map((warning) => (
                <div key={warning.code} className="check-item">
                  <span className="check-mark">·</span>
                  <span>
                    {warning.labelJa}
                    <span style={{ color: 'var(--muted)' }}> · {warning.count} 件</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="btn" onClick={() => { setPending(null); showToast('読み込みを中止しました（現在の文書はそのままです）'); }} data-testid="kotoha-loss-cancel">
                読み込まない
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const approval = pending;
                  setPending(null);
                  if (approval.request && !approval.request.isCurrent()) return;
                  void adopt(approval.output, approval.request, approval.context);
                }}
                data-testid="kotoha-loss-continue"
              >
                このまま読み込む
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exportOpen && document ? (
        <ExportModal
          toolLabel="Docx↔MD往復（琴葉）"
          defaultBase={document.bundle.fileName.replace(/\.docx$/i, '') || 'document'}
          onClose={() => setExportOpen(false)}
          note=".docx は「.docx を再構築」を実行したあとの最新結果を書き出します。"
          formats={[
            {
              id: 'docx',
              label: '.docx',
              description: 'スタイル・ヘッダー・フッターを保った再構築済み文書',
              fileName: (base) => `${base}.docx`,
              run: (base) => writeDocx(`${base}.docx`),
            },
            {
              id: 'bundle',
              label: '.kotoha.json',
              description: 'スタイルバンドルと編集済み Markdown',
              fileName: (base) => `${base}.kotoha.json`,
              run: (base) => exportBundle(base),
            },
            {
              id: 'markdown',
              label: '.md',
              description: '編集した Markdown 文書',
              fileName: (base) => `${base}.md`,
              run: async (base) => {
                markdownBinding.assertCurrent();
                await guardExport(
                  markdownBinding,
                  [
                    {
                      format: 'markdown',
                      fileName: `${base}.md`,
                      contentType: 'text/markdown',
                      entry: entryByRole('primary'),
                      payload: () => markdown,
                    },
                  ],
                  (bytes, name) => downloadBlob(name, bytes, 'text/markdown;charset=utf-8'),
                );
              },
              copy: () =>
                guardCopyText(markdownBinding, {
                  format: 'markdown',
                  fileName: `${document.bundle.fileName.replace(/\.docx$/i, '') || 'document'}.md`,
                  contentType: 'text/markdown',
                  entry: entryByRole('primary'),
                  text: markdown,
                }),
            },
          ]}
        />
      ) : null}
    </>
  );
}
