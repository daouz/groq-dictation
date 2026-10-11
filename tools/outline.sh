#!/usr/bin/env bash
# 列出各模組的區塊標題與頂層宣告（函式、常數、變數）及行號，用來找位置而不必整檔讀取。
# 用法：tools/outline.sh            全部
#       tools/outline.sh 40 50      只列檔名開頭是 40、50 的模組
cd "$(dirname "$0")/.." || exit 1
files=()
if [ $# -eq 0 ]; then files=(js/*.js); else for p in "$@"; do files+=(js/"$p"*.js); done; fi
for f in "${files[@]}"; do
  echo "== $f ($(wc -l < "$f") 行)"
  grep -nE '^/\* =+|^/\* -+|^(async )?function [A-Za-z_]|^(const|let|class) [A-Za-z_$]' "$f" \
    | sed -E 's#^([0-9]+):/\* [=-]+ (.*) [=-]+ \*/#\1: ▸ \2#; s#^([0-9]+):(async )?function ([A-Za-z_0-9]+)\(([^)]*)\).*#\1:   \3(\4)#; s#^([0-9]+):(const|let|class) ([^=;({]*).*#\1:   \2 \3#'
done
