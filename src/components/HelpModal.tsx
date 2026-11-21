import type { ToolMeta } from '../adapters/registry';
import { TOOLS } from '../adapters/registry';

export function HelpModal({ tool, onClose }: { tool: ToolMeta; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Help" data-testid="help-modal">
        <button type="button" className="icon-btn modal-close" aria-label="Close help" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
          </svg>
        </button>
        <h2>
          <span className="jp">青松館</span>
          <span>Help</span>
        </h2>
        <p>
          100% in-browser. Aosongkan is five documentation tools that run entirely in this browser tab:
          no source code, document or style bundle leaves the device, and nothing is uploaded to a server.
        </p>

        <h3>{tool.japanese} — {tool.english}</h3>
        <p>{tool.longDescription}</p>
        <ul>
          {tool.adapter.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>

        <h3>Getting around</h3>
        <ul>
          <li>Switch tools with the top bar chips or the <code>⋮</code> menu; each tool has its own address (<code>#/shiori</code>, <code>#/yayoi</code>, <code>#/kozue</code>, <code>#/haruhi</code>, <code>#/kotoha</code>).</li>
          <li>Toggle Deep Cedar (dark) and Mist Pine (light) with the sun/moon button. The choice is remembered locally.</li>
          <li>Paste code, drop a file, or press a sample chip to start. Files never leave the browser.</li>
          <li><code>?</code> or <code>Ctrl</code>/<code>Cmd</code> + <code>K</code> opens this help; <code>Esc</code> closes it.</li>
        </ul>

        <h3>All five tools</h3>
        <ul>
          {TOOLS.map((item) => (
            <li key={item.id}>
              <strong>{item.japanese}</strong> — {item.english}: {item.tagline}
            </li>
          ))}
        </ul>

        <h3>Privacy</h3>
        <p>
          Option A engines are deterministic and local. Kotoha keeps its style bundle in this browser&apos;s
          IndexedDB and can export a <code>.kotoha.json</code> file you control. A future hybrid AI mode
          (Option B) is opt-in per request and documented in <code>ARCHITECTURE.md</code>.
        </p>
      </div>
    </div>
  );
}
