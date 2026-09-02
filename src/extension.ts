import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parseHunks, mapOldToNew, type Hunk } from './gitDiff';

const pexec = promisify(execFile);

/** fsPath -> 解析基準としてスナップショットしたファイル内容 (セッション内のみ保持) */
const snapshots = new Map<string, string>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nawatobi.gotoLine', gotoLine),
    vscode.commands.registerCommand('nawatobi.snapshotBaseline', snapshotBaseline),
    vscode.commands.registerCommand('nawatobi.clearSnapshot', clearSnapshot),
  );
}

export function deactivate(): void {
  snapshots.clear();
}

// ---------------------------------------------------------------------------
// アクティブなタブから「変更後(working tree)」側の file: URI を得る
// ---------------------------------------------------------------------------
function activeModifiedUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

async function repoRootFor(fsPath: string): Promise<string> {
  const { stdout } = await pexec('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(fsPath),
  });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// snapshot コマンド
// ---------------------------------------------------------------------------
async function snapshotBaseline(): Promise<void> {
  const uri = activeModifiedUri();
  if (!uri || uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Nawatobi: アクティブなファイルがありません');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  snapshots.set(uri.fsPath, doc.getText());
  vscode.window.setStatusBarMessage(
    `Nawatobi: 解析基準スナップショットを記録 (${path.basename(uri.fsPath)}, ${doc.lineCount} 行)`,
    4000,
  );
}

async function clearSnapshot(): Promise<void> {
  const uri = activeModifiedUri();
  if (uri && snapshots.delete(uri.fsPath)) {
    vscode.window.setStatusBarMessage(
      `Nawatobi: スナップショットを削除 (${path.basename(uri.fsPath)})`,
      3000,
    );
  } else {
    vscode.window.showInformationMessage('Nawatobi: このファイルのスナップショットはありません');
  }
}

// ---------------------------------------------------------------------------
// 入力パース
//   番号がどちらのファイルの座標かを括弧が指す。飛び先は常に現在(working tree)。
//   123 / >123    -> plain  (番号 = 現在ファイルの座標。そのまま / line:col 可)
//   <123          -> map    (番号 = 過去=基準ファイルの座標 -> 現在行へ写像)
//   <HEAD~2:123   -> map    (基準を明示)
//   先頭 ':' は無視 (組み込み Go to Line の見た目に合わせる)
// ---------------------------------------------------------------------------
interface Parsed {
  mode: 'plain' | 'map';
  ref?: string;
  line: number;
  col?: number;
}

export function parseInput(raw: string): Parsed | undefined {
  let s = raw.trim();
  if (s.startsWith(':')) {
    s = s.slice(1).trim();
  }
  if (!s) {
    return undefined;
  }

  let mode: Parsed['mode'] = 'plain';
  if (s.startsWith('<')) {
    mode = 'map';
    s = s.slice(1).trim();
  } else if (s.startsWith('>')) {
    mode = 'plain';
    s = s.slice(1).trim();
  }

  let ref: string | undefined;
  if (mode === 'map' && s.includes(':')) {
    const i = s.indexOf(':');
    ref = s.slice(0, i).trim() || undefined;
    s = s.slice(i + 1).trim();
  }

  let col: number | undefined;
  if (mode === 'plain' && s.includes(':')) {
    const [l, c] = s.split(':');
    s = l.trim();
    const parsedCol = Number(c);
    col = Number.isFinite(parsedCol) ? parsedCol : undefined;
  }

  const line = Number(s);
  if (!Number.isInteger(line) || line <= 0) {
    return undefined;
  }
  return { mode, ref, line, col };
}

// ---------------------------------------------------------------------------
// git diff -U0 -> ハンク列
// ---------------------------------------------------------------------------
type Baseline = { kind: 'ref'; ref: string } | { kind: 'snapshot'; content: string };

async function computeHunks(
  repoRoot: string,
  fileFsPath: string,
  baseline: Baseline,
): Promise<Hunk[]> {
  if (baseline.kind === 'ref') {
    const rel = path.relative(repoRoot, fileFsPath);
    const { stdout } = await pexec(
      'git',
      ['diff', '-U0', '--no-color', baseline.ref, '--', rel],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    return parseHunks(stdout);
  }

  // snapshot: 一時ファイル(old) vs 実ファイル(new) を --no-index で diff
  const tmp = path.join(
    os.tmpdir(),
    `nawatobi-${process.pid}-${Date.now()}-${path.basename(fileFsPath)}`,
  );
  await fs.writeFile(tmp, baseline.content);
  try {
    // --no-index は差分があると exit code 1 を返す (エラーではない)
    const res = await pexec(
      'git',
      ['diff', '-U0', '--no-color', '--no-index', '--', tmp, fileFsPath],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: unknown) => {
      if (e && typeof (e as { stdout?: unknown }).stdout === 'string') {
        return e as { stdout: string };
      }
      throw e;
    });
    return parseHunks(res.stdout);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// メインコマンド
// ---------------------------------------------------------------------------
async function gotoLine(): Promise<void> {
  const uri = activeModifiedUri();
  if (!uri || uri.scheme !== 'file') {
    // 差分でも通常ファイルでもない -> 組み込みにフォールバック
    await vscode.commands.executeCommand('workbench.action.gotoLine');
    return;
  }

  const hasSnap = snapshots.has(uri.fsPath);
  const raw = await vscode.window.showInputBox({
    prompt: 'Nawatobi 行ジャンプ',
    placeHolder: `123 / >123 = 現在行  /  <123 = 基準(${hasSnap ? 'snapshot' : 'HEAD'})行→現在へ写像  /  <HEAD~2:123`,
    value: ':',
    valueSelection: [1, 1],
  });
  if (raw === undefined) {
    return;
  }

  const p = parseInput(raw);
  if (!p) {
    vscode.window.showWarningMessage('Nawatobi: 入力を解釈できません');
    return;
  }

  if (p.mode === 'plain') {
    await reveal(uri, p.line, p.col);
    return;
  }

  let repoRoot: string;
  try {
    repoRoot = await repoRootFor(uri.fsPath);
  } catch {
    vscode.window.showWarningMessage('Nawatobi: git リポジトリを特定できません');
    return;
  }

  const baseline: Baseline =
    !p.ref && hasSnap
      ? { kind: 'snapshot', content: snapshots.get(uri.fsPath)! }
      : { kind: 'ref', ref: p.ref ?? 'HEAD' };

  let hunks: Hunk[];
  try {
    hunks = await computeHunks(repoRoot, uri.fsPath, baseline);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showWarningMessage(`Nawatobi: git diff 失敗: ${msg}`);
    return;
  }

  const label = baseline.kind === 'snapshot' ? 'snapshot' : baseline.ref;

  const r = mapOldToNew(p.line, hunks);
  await reveal(uri, r.line);
  vscode.window.setStatusBarMessage(
    `Nawatobi: ${label} L${p.line} → 現在 L${r.line}` +
      (r.exact ? '' : '  ⚠ 近似 (変更領域内 → ハンク先頭)'),
    6000,
  );
}

// ---------------------------------------------------------------------------
// 指定行を表示 + カーソル移動
//   右ペイン(変更後)がフォーカス済みなら、その差分エディタ上で動かす。
//   それ以外はファイルを showTextDocument で開く。
// ---------------------------------------------------------------------------
async function reveal(uri: vscode.Uri, line1: number, col1?: number): Promise<void> {
  const current = vscode.window.activeTextEditor;
  let editor: vscode.TextEditor;
  if (current && current.document.uri.toString() === uri.toString()) {
    editor = current;
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }

  const lineCount = editor.document.lineCount;
  const line0 = Math.min(Math.max(0, line1 - 1), Math.max(0, lineCount - 1));
  const ch = Math.max(0, (col1 ?? 1) - 1);
  const pos = new vscode.Position(line0, ch);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
