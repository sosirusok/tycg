#!/usr/bin/env bash
# One-shot deploy to GitHub Pages (gh-pages branch).
# Usage:  bash deploy.sh
set -e

export PATH="/c/Users/edu/AppData/Local/node-v24.16.0-win-x64:/c/Program Files/GitHub CLI:$PATH"
cd "$(dirname "$0")"

echo "==> Building..."
node node_modules/vite/bin/vite.js build

echo "==> Publishing dist/ to gh-pages..."
touch dist/.nojekyll
cd dist
rm -rf .git
git init -q
git config user.name "sosirusok"
git config user.email "sosirusok@users.noreply.github.com"
git checkout -q -b gh-pages
git add -A
git commit -q -m "Deploy"
git push -f https://github.com/sosirusok/tycg.git gh-pages

echo "==> Done: https://sosirusok.github.io/tycg/"
