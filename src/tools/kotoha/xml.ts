/** Minimal, dependency-free XML reader used by the Kotoha OOXML engine. */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
  /** Byte offset of the opening `<` in the source string (set by `parseXml`). */
  start?: number;
  /** Offset just past the closing `>` in the source string. */
  end?: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#document', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const rest = xml.slice(i);
      if (rest.trim()) stack[stack.length - 1].children.push(decodeEntities(rest));
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].children.push(decodeEntities(text));
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const content = xml.slice(lt + 9, end === -1 ? len : end);
      stack[stack.length - 1].children.push(content);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) break;
    const raw = xml.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].tag === tag) {
          stack[s].end = gt + 1;
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).trim();
    const attrs = space === -1 ? {} : parseAttrs(body.slice(space));
    const node: XmlNode = { tag, attrs, children: [], start: lt, end: gt + 1 };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    else node.end = gt + 1;
    i = gt + 1;
  }
  return root;
}

export function child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  return node.children.find((c): c is XmlNode => typeof c !== 'string' && c.tag === tag);
}

export function children(node: XmlNode | undefined, tag: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c): c is XmlNode => typeof c !== 'string' && c.tag === tag);
}

export function descendants(node: XmlNode | undefined, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = '';
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (typeof c === 'string') out += c;
      else if (c.tag === 'w:t' || c.tag === 'a:t') out += textOf(c);
      else if (c.tag === 'w:tab') out += '\t';
      else if (c.tag === 'w:br' || c.tag === 'w:cr') out += '\n';
      else walk(c);
    }
  };
  walk(node);
  return out;
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  return node?.attrs[name];
}
