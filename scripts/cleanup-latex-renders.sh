#!/bin/bash
# cleanup-latex-renders.sh — 2026-05-31 磁盘优化
#
# LaTeX 渲染目录 /var/lib/slr/uploads/latex-renders/<projectId>/<renderId>/ 累积:
#   - 每个 render 的 fill/ 沙盒(模板拷贝 + sections + tables + figures,~8MB)
#   - latexmk 中间文件(.aux .fls .fdb_latexmk .bbl .blg .out ...)
#   - main.pdf(终产物)+ main.tex(源)+ figures/ + 模板 assets
#
# 策略(保守):
#   A. 所有 render:删 latexmk 中间文件(100% 可再生,从不被 serve)
#   B. 每个 project 保留最新 N=3 个 render 的完整目录(fill/ 等);
#      更老的 render:只留 main.pdf + main.tex,删 fill/ + figures/ + 模板 assets
#      (用户要重出 submission zip 时重新渲染即可)
#
# 用法:
#   bash scripts/cleanup-latex-renders.sh --dry-run            # 只统计
#   bash scripts/cleanup-latex-renders.sh --apply              # 真删
#   KEEP=5 bash scripts/cleanup-latex-renders.sh --apply       # 改保留数
#
# 环境:RENDERS_DIR 默认 /var/lib/slr/uploads/latex-renders

set -euo pipefail
MODE="${1:---dry-run}"
KEEP="${KEEP:-3}"
RENDERS_DIR="${RENDERS_DIR:-/var/lib/slr/uploads/latex-renders}"
INTERMEDIATES="main.aux main.fls main.fdb_latexmk main.bbl main.blg main.out main.toc main.lof main.lot"

if [ ! -d "$RENDERS_DIR" ]; then echo "no renders dir: $RENDERS_DIR"; exit 0; fi
APPLY=0; [ "$MODE" = "--apply" ] && APPLY=1

echo "RENDERS_DIR: $RENDERS_DIR"
echo "KEEP latest: $KEEP per project"
echo "Mode:        $([ $APPLY -eq 1 ] && echo APPLY || echo DRY-RUN)"
echo ""

human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }
freed=0

for projDir in "$RENDERS_DIR"/*/; do
  [ -d "$projDir" ] || continue
  proj=$(basename "$projDir")

  # A. 删所有 render 的 latexmk 中间文件
  for f in $INTERMEDIATES; do
    while IFS= read -r p; do
      [ -f "$p" ] || continue
      sz=$(stat -c%s "$p" 2>/dev/null || echo 0); freed=$((freed+sz))
      if [ $APPLY -eq 1 ]; then rm -f "$p"; fi
    done < <(find "$projDir" -maxdepth 2 -name "$f" 2>/dev/null)
  done

  # B. 保留最新 N 个 render 完整目录,更老的只留 main.pdf + main.tex
  #    render 目录按 mtime 降序,跳过前 KEEP 个
  mapfile -t renders < <(ls -1dt "$projDir"lr_*/ 2>/dev/null || true)
  idx=0
  for rdir in "${renders[@]}"; do
    idx=$((idx+1))
    [ $idx -le "$KEEP" ] && continue   # 最新 N 个完整保留
    # 老 render:删 fill/ + figures/ + 一切非 main.pdf/main.tex
    for sub in "$rdir"fill "$rdir"figures; do
      [ -d "$sub" ] || continue
      sz=$(du -sb "$sub" 2>/dev/null | cut -f1 || echo 0); freed=$((freed+sz))
      if [ $APPLY -eq 1 ]; then rm -rf "$sub"; fi
    done
    # 删模板 assets(.cls/.sty/.bst/.eps/.pdf 但保 main.pdf)+ supplementary
    while IFS= read -r p; do
      base=$(basename "$p")
      case "$base" in main.pdf|main.tex) continue;; esac
      sz=$(stat -c%s "$p" 2>/dev/null || echo 0); freed=$((freed+sz))
      if [ $APPLY -eq 1 ]; then rm -f "$p"; fi
    done < <(find "$rdir" -maxdepth 1 -type f \( -name '*.cls' -o -name '*.sty' -o -name '*.bst' -o -name '*.eps' -o -name '*.pdf' -o -name '*.def' -o -name '*.clo' \) 2>/dev/null)
  done
done

echo ""
echo "$([ $APPLY -eq 1 ] && echo '已释放' || echo '可释放(估算)'): $(human $freed)"
[ $APPLY -eq 0 ] && echo "(dry-run,加 --apply 真删)"
