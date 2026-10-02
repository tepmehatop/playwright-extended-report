/**
 * SEARCH/REPLACE edit blocks (the format small models follow most reliably,
 * more robust than unified diffs) + a unified-diff preview for the UI.
 */

export type EditBlock = { file: string, search: string, replace: string };

export type FileEdit = {
  /** Path as shown to the model / user. */
  file: string;
  oldContent: string;
  newContent: string;
  diff: string;
};

const kBlock = /FILE:\s*(.+?)\s*\n(?:```[\w-]*\n)?<{5,9} ?SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9} ?REPLACE/g;

export function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  for (const m of text.matchAll(kBlock))
    blocks.push({ file: m[1].replace(/^[`*]+|[`*]+$/g, '').trim(), search: m[2], replace: m[3] });
  return blocks;
}

/** Applies blocks to in-memory files. Exact match first, then a whitespace-tolerant line match. */
export function applyEditBlocks(blocks: EditBlock[], files: Map<string, string>): { edits: FileEdit[], problems: string[] } {
  const problems: string[] = [];
  const updated = new Map<string, string>();
  const resolveName = (name: string) => [...files.keys()].find(k => k === name) ?? [...files.keys()].find(k => k.endsWith('/' + name) || name.endsWith('/' + k) || k.split('/').pop() === name.split('/').pop());
  for (const block of blocks) {
    const name = resolveName(block.file);
    if (!name) {
      problems.push(`file "${block.file}" is not one of the listed files`);
      continue;
    }
    const content = updated.get(name) ?? files.get(name)!;
    const next = replaceOnce(content, block.search, block.replace);
    if (next === undefined) {
      problems.push(`SEARCH text not found in ${block.file}:\n${block.search.split('\n').slice(0, 5).join('\n')}`);
      continue;
    }
    updated.set(name, next);
  }
  const edits = [...updated.entries()].map(([file, newContent]) => {
    const oldContent = files.get(file)!;
    return { file, oldContent, newContent, diff: unifiedDiff(file, oldContent, newContent) };
  }).filter(e => e.oldContent !== e.newContent);
  if (!blocks.length)
    problems.push('no edit blocks found in the answer');
  return { edits, problems };
}

function replaceOnce(content: string, search: string, replace: string): string | undefined {
  if (search && content.includes(search)) {
    const index = content.indexOf(search);
    return content.slice(0, index) + replace + content.slice(index + search.length);
  }
  // Tolerate indentation / trailing whitespace differences.
  const lines = content.split('\n');
  const searchLines = search.split('\n').map(l => l.trim());
  while (searchLines.length && !searchLines[searchLines.length - 1])
    searchLines.pop();
  if (!searchLines.length)
    return undefined;
  for (let i = 0; i + searchLines.length <= lines.length; i++) {
    if (searchLines.every((l, j) => lines[i + j].trim() === l)) {
      const indent = lines[i].match(/^\s*/)![0];
      const replaceLines = replace.split('\n');
      const replaceIndent = replaceLines.find(l => l.trim())?.match(/^\s*/)![0] ?? '';
      const reindented = replaceLines.map(l => l.startsWith(replaceIndent) ? indent + l.slice(replaceIndent.length) : l);
      return [...lines.slice(0, i), ...reindented, ...lines.slice(i + searchLines.length)].join('\n');
    }
  }
  return undefined;
}

/** Minimal unified diff (LCS on lines, 3 lines of context). Files are small test sources. */
export function unifiedDiff(file: string, a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  // Trim common prefix / suffix to keep the LCS table small.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start])
    start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const lcs: number[][] = Array.from({ length: xs.length + 1 }, () => new Array(ys.length + 1).fill(0));
  for (let i = xs.length - 1; i >= 0; i--) {
    for (let j = ys.length - 1; j >= 0; j--)
      lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const body: string[] = [];
  let i = 0;
  let j = 0;
  while (i < xs.length || j < ys.length) {
    if (i < xs.length && j < ys.length && xs[i] === ys[j]) {
      body.push(' ' + xs[i++]);
      j++;
    } else if (i < xs.length && (j >= ys.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      body.push('-' + xs[i++]);
    } else {
      body.push('+' + ys[j++]);
    }
  }
  const before = x.slice(Math.max(0, start - 3), start).map(l => ' ' + l);
  const after = x.slice(endX, endX + 3).map(l => ' ' + l);
  const oldStart = Math.max(0, start - 3) + 1;
  const oldCount = before.length + xs.length + after.length;
  const newCount = before.length + ys.length + after.length;
  return [`--- a/${file}`, `+++ b/${file}`, `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@`, ...before, ...body, ...after].join('\n');
}
