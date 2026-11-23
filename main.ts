// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order, so the output can print R rows. */
  readonly moves: { old: string; new: string }[] = [];
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
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
    if (blank(l)) return;
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

// ---------------------------------------------------------------------------
// Files, lines and matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

/** A file's lines, its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at a tier, starting at or after `from`. */
function occurrencesFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesFrom(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line) or an added line. */
interface NPart {
  text: string;
  ctx: boolean;
  /** Index into O for a context line, -1 otherwise. */
  oPos: number;
}

/** Build the lines that replace O's occurrence, per section 5. */
function buildReplacement(fileLines: string[], o: string[], n: NPart[], tier: number, occ: number): string[] {
  const P = leadingWs(o[0] ?? '');
  const F = leadingWs(fileLines[occ] ?? '');
  return n.map((part) => {
    if (part.ctx) return fileLines[occ + part.oPos]!;
    if (tier === 2) {
      const line = part.text;
      if (line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(P)) return F + line.slice(P.length);
      return line;
    }
    return part.text;
  });
}

/** A hunk/chunk body line. `backslash` marks a `\` line following it. */
interface BodyItem {
  type: 'ctx' | 'old' | 'new';
  text: string;
  backslash?: boolean;
}

/** Split body items into O (context + old) and N (context + new). */
function splitItems(items: BodyItem[]): { o: string[]; n: NPart[] } {
  const o: string[] = [];
  const n: NPart[] = [];
  for (const it of items) {
    if (it.type === 'ctx') {
      const pos = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oPos: pos });
    } else if (it.type === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: false, oPos: -1 });
    }
  }
  return { o, n };
}

/** The hunk's last context or `+` line, if any. */
function lastCtxOrPlus(items: BodyItem[]): BodyItem | undefined {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.type === 'ctx' || it.type === 'new') return it;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old-file start line A from the header (1-based). */
  a: number;
  items: BodyItem[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path named by a `--- ` or `+++ ` line; null for /dev/null. */
function parseDashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** One hunk starting at lines[i]; returns it and the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const items: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ type: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ type: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ type: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ type: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      if (items.length > 0) items[items.length - 1]!.backslash = true;
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.type === 'ctx' && last.text === '' && !last.backslash) items.pop();
    else break;
  }
  return { hunk: { a, items }, next: j };
}

/** Apply one hunk to a file's state; `d` is the length drift of this section's earlier hunks. */
function applyUnifiedHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n } = splitItems(hunk.items);
  if (o.length === 0) {
    const pos = Math.min(hunk.a + d, state.lines.length);
    const newLines = [...state.lines.slice(0, pos), ...n.map((p) => p.text), ...state.lines.slice(pos)];
    let ewb = state.endsWithBreak;
    if (pos === state.lines.length) {
      const last = lastCtxOrPlus(hunk.items);
      ewb = !(last?.backslash ?? false);
    }
    return { lines: newLines, br: state.br, endsWithBreak: ewb };
  }
  const found = findTier(state.lines, o, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let occ = found.occ[0]!;
  let best = Math.abs(occ - target);
  for (const p of found.occ) {
    const dd = Math.abs(p - target);
    if (dd < best) {
      best = dd;
      occ = p;
    }
  }
  const replacement = buildReplacement(state.lines, o, n, found.tier, occ);
  const newLines = [...state.lines.slice(0, occ), ...replacement, ...state.lines.slice(occ + o.length)];
  let ewb = state.endsWithBreak;
  if (occ + o.length === state.lines.length) {
    const last = lastCtxOrPlus(hunk.items);
    ewb = !(last?.backslash ?? false);
  }
  return { lines: newLines, br: state.br, endsWithBreak: ewb };
}

/** Apply a section's hunks in order to a file's state. */
function applyUnifiedHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let state = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitItems(h.items);
    state = applyUnifiedHunk(state, h, d, strict, path);
    d += n.length - o.length;
  }
  return joinFile(state);
}

/**
 * One unified section. `start` is the index after the `diff --git` line, or the
 * index of the `--- ` line for a section that starts at a `--- `+`+++ ` pair
 * (then gitOld/gitNew are null). Returns the edit and the index after the section.
 */
function parseUnifiedSection(
  lines: string[],
  start: number,
  gitOld: string | null,
  gitNew: string | null,
  strict: boolean,
): { edit: Edit; next: number } {
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let dashSeen = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let newFile = false;
  let deletedFile = false;
  const hunks: Hunk[] = [];
  let i = start;
  const n = lines.length;
  if (gitOld === null) {
    dashOld = parseDashPath(lines[i]!);
    dashNew = parseDashPath(lines[i + 1]!);
    dashSeen = true;
    i += 2;
  }
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!dashSeen) {
          dashOld = parseDashPath(line);
          dashNew = parseDashPath(lines[i + 1]!);
          dashSeen = true;
        }
        i += 2;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  const oldP: string | null | undefined = dashSeen ? dashOld : (renameFrom ?? gitOld ?? undefined);
  const newP: string | null | undefined = dashSeen ? dashNew : (renameTo ?? gitNew ?? undefined);
  const kind: 'create' | 'delete' | 'move' | 'change' =
    oldP === null || newFile
      ? 'create'
      : newP === null || deletedFile
        ? 'delete'
        : oldP !== undefined && newP !== undefined && oldP !== newP
          ? 'move'
          : 'change';
  const edit: Edit = (tree) => {
    if (kind === 'create') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of hunks)
        for (const it of h.items)
          if (it.type === 'new') {
            plus.push(it.text);
            lastPlusBackslash = it.backslash ?? false;
          }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move') {
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, applyUnifiedHunks(before, hunks, strict, op));
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, hunks, strict, p));
  };
  return { edit, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec = parseUnifiedSection(lines, i + 1, m[1]!, m[2]!, strict);
      edits.push(sec.edit);
      i = sec.next;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = parseUnifiedSection(lines, i, null, null, strict);
      edits.push(sec.edit);
      i = sec.next;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | undefined;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | undefined;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let sep = -1;
    for (let j = i + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const occ = found.occ[0]!;
      const replacement = buildReplacement(
        f.lines,
        oldLines,
        newLines.map((t) => ({ text: t, ctx: false, oPos: -1 })),
        found.tier,
        occ,
      );
      const out = [...f.lines.slice(0, occ), ...replacement, ...f.lines.slice(occ + oldLines.length)];
      tree.now.set(p, joinFile({ lines: out, br: f.br, endsWithBreak: f.endsWithBreak }));
    });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** Apply one V4A chunk; returns the new state and the cursor after the lines written. */
function applyV4aChunk(
  state: FileState,
  chunk: VChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { state: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let foundIdx: number | null = null;
    const maxTier = strict ? 0 : 2;
    for (let t = 0; t <= maxTier && foundIdx === null; t++) {
      for (let k = cur; k < state.lines.length; k++) {
        if (tierKey(state.lines[k]!, t) === tierKey(chunk.anchor, t)) {
          foundIdx = k;
          break;
        }
      }
    }
    if (foundIdx === null) throw new Fail('no-match', path);
    cur = foundIdx + 1;
  }
  const { o, n } = splitItems(chunk.items);
  if (o.length === 0) {
    const pos = chunk.eof ? state.lines.length : cur;
    const newLines = [...state.lines.slice(0, pos), ...n.map((p) => p.text), ...state.lines.slice(pos)];
    return { state: { lines: newLines, br: state.br, endsWithBreak: state.endsWithBreak }, cursor: pos + n.length };
  }
  const found = findTier(state.lines, o, strict, cur);
  if (!found) throw new Fail('no-match', path);
  let occ: number;
  if (chunk.eof) {
    const endOcc = found.occ.filter((p) => p + o.length === state.lines.length);
    if (endOcc.length === 0) throw new Fail('no-match', path);
    occ = endOcc[0]!;
  } else {
    occ = found.occ[0]!;
  }
  const replacement = buildReplacement(state.lines, o, n, found.tier, occ);
  const newLines = [...state.lines.slice(0, occ), ...replacement, ...state.lines.slice(occ + o.length)];
  return { state: { lines: newLines, br: state.br, endsWithBreak: state.endsWithBreak }, cursor: occ + replacement.length };
}

/** Strip trailing context lines whose text is empty or only whitespace (blank patch lines). */
function stripV4aTrailing(items: BodyItem[]): void {
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.type === 'ctx' && /^[ \t]*$/.test(last.text)) items.pop();
    else break;
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const sectionLines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        )
          break;
        if (l.startsWith('+')) {
          sectionLines.push(l.slice(1));
          j++;
          continue;
        }
        if (blank(l)) {
          sectionLines.push('');
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1] === '') sectionLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, sectionLines.length === 0 ? '' : sectionLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        )
          break;
        if (blank(l)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | undefined;
      let k = j;
      while (k < last && blank(lines[k]!)) k++;
      if (k < last && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        j = k + 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < last) {
        const l = lines[j]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        )
          break;
        if (l.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${j + 1}`);
        if (l.startsWith('***')) throw new Exit2(`error: parse ${j + 1}`);
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          j++;
          continue;
        }
        if (blank(l)) {
          if (!cur) {
            if (chunks.length > 0) {
              j++;
              continue;
            }
            cur = { anchor: null, eof: false, items: [] };
          }
          cur.items.push({ type: 'ctx', text: '' });
          j++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!cur) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, items: [] };
          }
          cur.items.push({
            type: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l.slice(1),
          });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur) {
        stripV4aTrailing(cur.items);
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== undefined) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        let state = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          const r = applyV4aChunk(state, chunk, cursor, strict, path);
          state = r.state;
          cursor = r.cursor;
        }
        const text = joinFile(state);
        if (moveTo !== undefined) {
          tree.now.set(moveTo, text);
          tree.now.set(path, null);
          tree.moves.push({ old: path, new: moveTo });
        } else {
          tree.now.set(path, text);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
