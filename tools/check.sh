#!/usr/bin/env bash
# 修改後的檢查：語法、載入順序、版本號，最後跑冒煙測試與儲存測試。
# 用法：tools/check.sh          全部
#       tools/check.sh --fast   不跑瀏覽器冒煙測試
cd "$(dirname "$0")/.." || exit 1
fail=0
for f in js/*.js; do node --check "$f" || { echo "語法錯誤：$f"; fail=1; }; done
[ $fail -eq 0 ] && echo "語法 OK"
node tools/hoist-check.cjs js/*.js || fail=1
node tools/stamp.mjs --check || fail=1
if [ "$1" != "--fast" ]; then node tools/smoke.mjs "${SHOTS:-}" || fail=1; node tools/store-test.mjs || fail=1; fi
[ $fail -eq 0 ] && echo "全部通過" || echo "有檢查未通過"
exit $fail
