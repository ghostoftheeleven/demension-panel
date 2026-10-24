#!/usr/bin/env bash
# Публикация релиза GitHub для версии из корневого package.json (вызывается .github/workflows/release.yml после зелёного CI).
#   bash .github/scripts/release.sh              создать тег и релиз (нужны GH_TOKEN и SHA)
#   bash .github/scripts/release.sh --notes      только вывести текст релиза из CHANGELOG.md
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Версия в package.json должна быть X.Y.Z, сейчас: $VERSION" >&2
  exit 1
fi
TAG="v$VERSION"

# Раздел «## vX.Y.Z …» до следующего раздела «## v»
NOTES="$(awk -v tag="$TAG" '
  /^## v[0-9]/ { if (found) exit; if ($2 == tag) { found = 1; next } }
  found { print }
' CHANGELOG.md)"
if [ -z "$(printf '%s' "$NOTES" | tr -d '[:space:]')" ]; then
  echo "В CHANGELOG.md нет раздела «## $TAG» с описанием изменений" >&2
  exit 1
fi

if [ "${1:-}" = "--notes" ]; then
  printf '%s\n' "$NOTES"
  exit 0
fi

git fetch --tags --quiet
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Релиз $TAG уже опубликован — пропуск"
  exit 0
fi

# Номер не должен уменьшаться: иначе панели не увидят обновление
LAST="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -n 1)"
if [ -n "$LAST" ] && [ "$(printf '%s\n%s\n' "$LAST" "$TAG" | sort -V | tail -n 1)" != "$TAG" ]; then
  echo "Версия $TAG меньше последнего релиза $LAST" >&2
  exit 1
fi

printf '%s\n' "$NOTES" > "${RUNNER_TEMP:-/tmp}/release-notes.md"
gh release create "$TAG" --target "${SHA:?нужен SHA коммита}" --title "$TAG" --notes-file "${RUNNER_TEMP:-/tmp}/release-notes.md" --latest
echo "Опубликован релиз $TAG"
