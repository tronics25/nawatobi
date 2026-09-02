# Change Log

## 0.1.0

- 初版。
- 差分エディタ向けの baseline 対応 Go to Line。
  - `<123` … 過去（基準）ファイルの行番号を `git diff -U0` のハンク経由で現在の作業ツリー行へ写像してジャンプ。
  - `<HEAD~2:123` … 基準コミットを明示。
  - `123` / `>123` … 現在ファイルの行番号（組み込みと同じ）。
- `Nawatobi: Snapshot current file as analysis baseline` … 未コミット状態を解析基準として記録。
- 変更領域内に着地した場合はハンク先頭へ丸め、`⚠ 近似` を表示。
