/**
 * `git diff -U0` のハンクヘッダ (`@@ -old,c +new,c @@`) をパースして、
 * 旧(baseline)行 <-> 新(working tree)行の写像を作る。
 *
 * -U0 なので:
 *   - 変更          `@@ -100,3 +100,5 @@`
 *   - 純削除        `@@ -100,2 +99,0 @@`
 *   - 純挿入        `@@ -100,0 +101,3 @@`  (旧100行目の "後ろ" に挿入)
 * count 省略時は 1。
 */

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export function parseHunks(diffText: string): Hunk[] {
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const hunks: Hunk[] = [];
  for (let m = re.exec(diffText); m; m = re.exec(diffText)) {
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

export interface MapResult {
  /** 写像先の行 (1-based) */
  line: number;
  /**
   * true  = 変更されていない行なので厳密に対応が取れた
   * false = 対象行が変更/削除/挿入領域の中にあり、ハンク先頭に丸めた近似
   */
  exact: boolean;
}

/** baseline(old) の行 `target` を working tree(new) の行へ写像する。 */
export function mapOldToNew(target: number, hunks: Hunk[]): MapResult {
  let offset = 0;
  for (const h of hunks) {
    // 純挿入は「行と行の間」に位置するので 0.5 ずらして判定する
    const changeAt = h.oldCount === 0 ? h.oldStart + 0.5 : h.oldStart;
    if (target < changeAt) {
      break;
    }
    if (h.oldCount > 0 && target < h.oldStart + h.oldCount) {
      return { line: h.newStart, exact: false };
    }
    offset += h.newCount - h.oldCount;
  }
  return { line: Math.max(1, target + offset), exact: true };
}

/** working tree(new) の行 `target` を baseline(old) の行へ写像する。 */
export function mapNewToOld(target: number, hunks: Hunk[]): MapResult {
  let offset = 0;
  for (const h of hunks) {
    const changeAt = h.newCount === 0 ? h.newStart + 0.5 : h.newStart;
    if (target < changeAt) {
      break;
    }
    if (h.newCount > 0 && target < h.newStart + h.newCount) {
      return { line: h.oldStart, exact: false };
    }
    offset += h.oldCount - h.newCount;
  }
  return { line: Math.max(1, target + offset), exact: true };
}
