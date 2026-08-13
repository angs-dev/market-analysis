/**
 * Minimal XML reader, sufficient for RSS 2.0 and Atom feeds.
 *
 * Not a conforming XML processor: no DTDs, no namespaces resolution, no entity
 * definitions beyond the predefined five plus numeric references. It handles
 * what feeds actually contain — elements, attributes, text, CDATA, comments,
 * processing instructions and self-closing tags — and throws on malformed
 * structure rather than guessing.
 */

export class XmlError extends Error {}

export interface XmlNode {
  /** Tag name with any namespace prefix stripped, lower-cased. */
  name: string;
  /** Original tag name as written. */
  rawName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element, concatenated and entity-decoded. */
  text: string;
}

const PREDEFINED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (ref.startsWith('#')) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return PREDEFINED[ref.toLowerCase()] ?? match;
  });
}

function localName(raw: string): string {
  const colon = raw.indexOf(':');
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[localName(m[1]!)] = decodeEntities(value);
  }
  return attrs;
}

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: '#root', rawName: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const top = (): XmlNode => stack[stack.length - 1]!;

  while (i < input.length) {
    const lt = input.indexOf('<', i);

    if (lt === -1) {
      top().text += decodeEntities(input.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(input.slice(i, lt));

    // <![CDATA[ ... ]]> — taken verbatim, no entity decoding.
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt);
      if (end === -1) throw new XmlError('unterminated CDATA section');
      top().text += input.slice(lt + 9, end);
      i = end + 3;
      continue;
    }

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
      continue;
    }

    // <?xml ... ?> and <!DOCTYPE ...>
    if (input.startsWith('<?', lt) || input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt);
      if (end === -1) throw new XmlError('unterminated declaration');
      i = end + 1;
      continue;
    }

    const gt = input.indexOf('>', lt);
    if (gt === -1) throw new XmlError('unterminated tag');
    const inner = input.slice(lt + 1, gt).trim();

    if (inner.startsWith('/')) {
      const name = localName(inner.slice(1).trim());
      if (stack.length === 1) throw new XmlError(`unexpected closing tag </${name}>`);
      const open = stack.pop()!;
      if (open.name !== name) {
        throw new XmlError(`closing tag </${name}> does not match <${open.rawName}>`);
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const space = body.search(/\s/);
    const rawName = space === -1 ? body : body.slice(0, space);
    if (rawName === '') throw new XmlError('empty tag name');

    const node: XmlNode = {
      name: localName(rawName),
      rawName,
      attrs: space === -1 ? {} : parseAttrs(body.slice(space)),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  if (stack.length !== 1) {
    throw new XmlError(`unclosed tag <${stack[stack.length - 1]!.rawName}>`);
  }
  return root;
}

/** First descendant with this local name, depth-first. */
export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return undefined;
}

/** All descendants with this local name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const child of n.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Trimmed text of the first direct child with this name. */
export function childText(node: XmlNode, name: string): string | undefined {
  const child = node.children.find((c) => c.name === name);
  return child ? child.text.trim() : undefined;
}
