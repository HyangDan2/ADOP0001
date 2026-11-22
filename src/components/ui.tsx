import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LineEditor(props: {
  value: string;
  onChange: (value: string) => void;
  highlightLines?: number[];
  placeholder?: string;
  readOnly?: boolean;
  ariaLabel?: string;
  onLineFocus?: (line: number) => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, props.value.split('\n').length);
  const highlight = new Set(props.highlightLines ?? []);

  useEffect(() => {
    if (areaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  }, [props.value, props.highlightLines]);

  return (
    <div className="editor-wrap">
      <div className="editor-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => (
          <div key={index} className={highlight.has(index + 1) ? 'hl' : undefined}>
            {index + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={areaRef}
        className="editor-area"
        value={props.value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={props.ariaLabel ?? 'ソースコード'}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        onChange={(event) => props.onChange(event.target.value)}
        onScroll={(event) => {
          if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onSelect={(event) => {
          if (!props.onLineFocus) return;
          const caret = event.currentTarget.selectionStart ?? 0;
          props.onLineFocus(props.value.slice(0, caret).split('\n').length);
        }}
        data-testid="source-editor"
      />
    </div>
  );
}

export function useDropFile(onFile: (file: File) => void) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (event: React.DragEvent) => {
      event.preventDefault();
      depth.current += 1;
      setActive(true);
    },
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
    },
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setActive(false);
      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
  };
  return { active, handlers };
}

export function ToolPane(props: { title: string; actions?: ReactNode; children: ReactNode; foot?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`pane ${props.className ?? ''}`} data-testid={props.testId}>
      <header className="pane-head">
        <span className="pane-title">{props.title}</span>
        {props.actions}
      </header>
      <div className="pane-body">{props.children}</div>
      {props.foot ? <footer className="pane-foot">{props.foot}</footer> : null}
    </section>
  );
}

export function EmptyHint(props: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-hint">
      <strong style={{ color: 'var(--ink)', fontSize: 13 }}>{props.title}</strong>
      {props.children}
    </div>
  );
}
