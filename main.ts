// mend — the CLI SPEC.md specifies. Written fresh from SPEC.md (version 1).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// One run reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), applies its edits to the tree in the working
// directory — every change or none — and prints what changed or why it failed.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its break, its lines, whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/**
 * The tree as the edits leave it. `now` holds what changed (null: deleted);
 * anything else is read from disk on first use. `moves` records the
 * successful move edits, in order, so the output can print R lines.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** One edit: apply it to the tree, or throw a Fail. */
type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

/** Line equality at one tier: 0 exact, 1 trailing spaces/tabs stripped, 2 both sides stripped. */
function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(tier, o[j] as string, lines[i + j] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NewLine {
  text: string;
  ctx: boolean;
  /** For a context line, its index in O. */
  oIndex: number;
}

/**
 * The lines that replace a match at `pos`: context lines come from the file,
 * other lines are written as they are — except at tier 2, where a non-empty,
 * non-whitespace line starting with P (the leading spaces/tabs of O's first
 * line) has that P replaced by F (the leading spaces/tabs of the file's
 * first matched line).
 */
function buildNew(lines: string[], pos: number, o: string[], items: NewLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos] as string);
    p = leadWs(o[0] as string);
  }
  const out: string[] = [];
  for (const it of items) {
    if (it.ctx) {
      out.push(lines[pos + it.oIndex] as string);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Split a hunk/chunk body into O (context + old lines) and N (context + new lines). */
function splitBody(body: BodyLine[]): { o: string[]; items: NewLine[] } {
  const o: string[] = [];
  const items: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      items.push({ text: b.text, ctx: true, oIndex: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      items.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, items };
}

/** A body line from its raw patch line: ' ' context, '-' old, '+' new, '' context with empty text. */
function bodyLineOf(raw: string): BodyLine {
  if (raw === '') return { kind: 'ctx', text: '' };
  if (raw.startsWith(' ')) return { kind: 'ctx', text: raw.slice(1) };
  if (raw.startsWith('-')) return { kind: 'old', text: raw.slice(1) };
  return { kind: 'new', text: raw.slice(1) };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The old start line A from the hunk header. */
  a: number;
  body: BodyLine[];
  /** A \ line follows the hunk's last context or + line. */
  noFinal: boolean;
  /** A \ line follows the hunk's last + line; null when there is no + line. */
  plusNoFinal: boolean | null;
}

function makeHunk(a: number, raw: string[]): Hunk {
  const body = raw.filter((l) => !l.startsWith('\\')).map(bodyLineOf);
  let lastCtxNew = -1;
  let lastPlus = -1;
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i] as string;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxNew = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const noFinal = lastCtxNew >= 0 && raw[lastCtxNew + 1] !== undefined && (raw[lastCtxNew + 1] as string).startsWith('\\');
  const plusNoFinal = lastPlus < 0 ? null : raw[lastPlus + 1] !== undefined && (raw[lastPlus + 1] as string).startsWith('\\');
  return { a, body, noFinal, plusNoFinal };
}

interface Section {
  old: string | null;
  nw: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
  /** For creations: whether a \ line follows the section's last + line; null when there is no + line. */
  plusNoFinal: boolean | null;
}

interface RawSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A ---/+++ path: text after the four characters, up to the first tab, surrounding spaces removed, a/ or b/ stripped, /dev/null means no file. */
function parsePatchPath(s: string): string | null {
  let p = (s.split('\t')[0] as string).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function finishSection(r: RawSection): Section {
  const old = r.hasPair ? r.pairOld : (r.renFrom ?? r.diffOld);
  const nw = r.hasPair ? r.pairNew : (r.renTo ?? r.diffNew);
  let kind: Section['kind'];
  if (old === null || r.create) kind = 'create';
  else if (nw === null || r.del) kind = 'delete';
  else if (old !== nw) kind = 'move';
  else kind = 'change';
  let plusNoFinal: boolean | null = null;
  for (const h of r.hunks) if (h.plusNoFinal !== null) plusNoFinal = h.plusNoFinal;
  return { old, nw, kind, hunks: r.hunks, plusNoFinal };
}

function parseUnified(lines: string[]): Section[] {
  const raws: RawSection[] = [];
  let cur: RawSection | null = null;
  const n = lines.length;
  let i = 0;
  const newRaw = (): RawSection => ({
    diffOld: null, diffNew: null, pairOld: null, pairNew: null, hasPair: false,
    renFrom: null, renTo: null, create: false, del: false, hunks: [],
  });
  const diffGit = (l: string): [string, string] | null => {
    if (!l.startsWith('diff --git ')) return null;
    const rest = l.slice('diff --git '.length);
    if (!rest.startsWith('a/')) return null;
    const sep = rest.indexOf(' b/', 2);
    if (sep < 0) return null;
    const x = rest.slice(2, sep);
    const y = rest.slice(sep + 3);
    if (x === '' || y === '') return null;
    return [x, y];
  };
  while (i < n) {
    const l = lines[i] as string;
    const ln = i + 1;
    if (l.startsWith('diff --git ')) {
      const g = diffGit(l);
      if (g === null) throw new Exit2(`error: parse ${ln}`);
      cur = newRaw();
      cur.diffOld = g[0];
      cur.diffNew = g[1];
      raws.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = parsePatchPath(l.slice(4));
      const w = parsePatchPath((lines[i + 1] as string).slice(4));
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.pairOld = o;
        cur.pairNew = w;
        cur.hasPair = true;
      } else {
        cur = newRaw();
        cur.pairOld = o;
        cur.pairNew = w;
        cur.hasPair = true;
        raws.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const a = parseInt(m[1] as string, 10);
      i++;
      const raw: string[] = [];
      while (i < n) {
        const bl = lines[i] as string;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      cur.hunks.push(makeHunk(a, raw));
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ') && !cur.hasPair && cur.renFrom === null) cur.renFrom = l.slice('rename from '.length);
      else if (l.startsWith('rename to ') && !cur.hasPair && cur.renTo === null) cur.renTo = l.slice('rename to '.length);
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.create = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.del = true;
    }
    i++;
  }
  return raws.map(finishSection);
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path) when a hunk finds nothing. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, items } = splitBody(h.body);
    if (o.length === 0) {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > f.lines.length) idx = f.lines.length;
      const atEnd = idx === f.lines.length;
      const ins = items.map((it) => it.text);
      f.lines.splice(idx, 0, ...ins);
      if (atEnd) f.final = !h.noFinal;
      d += items.length;
      continue;
    }
    const found = findTier(f.lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0] as number;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === f.lines.length;
    const repl = buildNew(f.lines, best, o, items, found.tier);
    f.lines.splice(best, o.length, ...repl);
    if (atEnd) f.final = !h.noFinal;
    d += items.length - o.length;
  }
  return renderFile(f);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.old;
    const newP = sec.nw;
    if (oldP !== null && !safePath(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safePath(newP)) throw new Fail('unsafe', newP);
    if (sec.kind === 'create') {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') ls.push(b.text);
      tree.set(newP, ls.length === 0 ? '' : ls.join('\n') + (sec.plusNoFinal === true ? '' : '\n'));
      return;
    }
    if (sec.kind === 'delete') {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP === null) return;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (sec.kind === 'move' && newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = applyHunks(before, sec.hunks, strict, oldP);
    if (sec.kind === 'move' && newP !== null) {
      tree.set(oldP, null);
      tree.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.set(oldP, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0] as number;
    const items = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const repl = buildNew(f.lines, pos, oldLines, items, found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.set(path, renderFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j] as string;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  body: BodyLine[];
  /** True when the chunk ends at a *** End of File line. */
  eof: boolean;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, raw: string[], startIdx: number, headerLn: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let j = 0; j < raw.length; j++) {
      const l = raw[j] as string;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${startIdx + j + 1}`);
    }
    return (tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let j = 0; j < raw.length; j++) {
      if (!isBlank(raw[j] as string)) throw new Exit2(`error: parse ${startIdx + j + 1}`);
    }
    return (tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && (raw[0] as string).startsWith(V4A_MOVE)) {
    moveTo = (raw[0] as string).slice(V4A_MOVE.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  for (let j = idx; j < raw.length; j++) {
    const l = raw[j] as string;
    const ln = startIdx + j + 1;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, body: [], eof: false };
      firstChunk = false;
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      firstChunk = false;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, body: [], eof: false };
        firstChunk = false;
      }
      cur.body.push(bodyLineOf(l));
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLn}`);
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const { o, items } = splitBody(ch.body);
      if (ch.anchor !== null) {
        let foundLine = -1;
        const top = strict ? 1 : 3;
        for (let t = 0; t < top && foundLine < 0; t++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierEq(t, ch.anchor, f.lines[k] as string)) {
              foundLine = k;
              break;
            }
          }
        }
        if (foundLine < 0) throw new Fail('no-match', path);
        cursor = foundLine + 1;
      }
      if (o.length === 0) {
        const ins = items.map((it) => it.text);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.occ[0] as number;
      if (ch.eof) {
        const end = found.occ.find((p) => p + o.length === f.lines.length);
        if (end === undefined) throw new Fail('no-match', path);
        pos = end;
      }
      const repl = buildNew(f.lines, pos, o, items, found.tier);
      f.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let j = 0; j < n; j++) {
    if (!isBlank(lines[j] as string)) {
      first = j;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!isBlank(lines[j] as string)) {
      last = j;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isHeader = (l: string): boolean => l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (l.trim() === '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
    if (!isHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLn = i + 1;
    const kind = l.startsWith(V4A_ADD) ? 'add' : l.startsWith(V4A_DEL) ? 'delete' : 'update';
    const prefix = kind === 'add' ? V4A_ADD : kind === 'delete' ? V4A_DEL : V4A_UPD;
    const path = l.slice(prefix.length).trim();
    i++;
    const startIdx = i;
    const raw: string[] = [];
    while (i < last) {
      const cl = lines[i] as string;
      if (isHeader(cl)) break;
      if (cl.trim() === '*** End Patch') break;
      raw.push(cl);
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1] as string)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, startIdx, headerLn, strict));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                            */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0] as string;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const dIdx = rows.findIndex((r) => r.text === `D ${oldP}`);
    const aIdx = rows.findIndex((r) => r.text === `A ${newP}`);
    if (dIdx >= 0 && aIdx >= 0) {
      rows.splice(Math.max(dIdx, aIdx), 1);
      rows.splice(Math.min(dIdx, aIdx), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
