# Change Log

## 0.1.1

- コマンド名を変更: `Snapshot current file as analysis baseline` → `Snapshot current file as baseline`、`Clear analysis baseline snapshot` → `Clear baseline snapshot`。
- README を整理（用途説明の簡潔化、開発向け記述の削除）。
- 挙動の変更なし。

## 0.1.0

- 初版。
- 差分エディタ向けの baseline 対応 Go to Line。
  - `<123` … 過去（基準）ファイルの行番号を `git diff -U0` のハンク経由で現在の作業ツリー行へ写像してジャンプ。
  - `<HEAD~2:123` … 基準コミットを明示。
  - `123` / `>123` … 現在ファイルの行番号（組み込みと同じ）。
- `Nawatobi: Snapshot current file as baseline` … 未コミットの状態を基準として記録。
- 変更領域内に着地した場合はハンク先頭へ丸め、`⚠ 近似` を表示。
