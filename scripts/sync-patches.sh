#!/bin/bash

# Sync patches directory with current commits
# Usage: ./scripts/sync-patches.sh [base-commit]
# Default base commit: 2d58e9290237f09c09331383e0416dcb55356450

BASE_COMMIT="${1:-be33a66e8c113bb5869cceec1ed6777f0d40ceb8}"
PATCHES_DIR="./patches"
TEMP_DIR=$(mktemp -d)

echo "Syncing patches from base commit: $BASE_COMMIT"

# Get list of commits after base commit
COMMITS=$(git rev-list "${BASE_COMMIT}..HEAD" --reverse)

if [ -z "$COMMITS" ]; then
  echo "No new commits since base commit. Patches are up to date."
  rm -rf "$TEMP_DIR"
  exit 0
fi

# Generate patches in temporary directory
PATCH_NUM=1
for commit in $COMMITS; do
  # Pad number with zeros for sorting
  PADDED_NUM=$(printf "%04d" "$PATCH_NUM")

  # Get commit subject for patch filename
  SUBJECT=$(git log -1 --format=%s "$commit" | sed 's/[^a-zA-Z0-9-]/-/g; s/-*$//; s/^-*//; s/-{2,}/-/g' | cut -c1-50)

  # Ensure subject isn't empty
  if [ -z "$SUBJECT" ]; then
    SUBJECT="patch-$PATCH_NUM"
  fi

  PATCH_FILE="${TEMP_DIR}/${PADDED_NUM}-${SUBJECT}.patch"

  # Generate patch
  git format-patch -1 "$commit" --start-number "$PATCH_NUM" -o "$TEMP_DIR" > /dev/null

  PATCH_NUM=$((PATCH_NUM + 1))
done

# Clean patches directory and copy new patches
rm -f "$PATCHES_DIR"/*.patch
cp "$TEMP_DIR"/*.patch "$PATCHES_DIR/" 2>/dev/null

# List generated patches
echo "Generated patches:"
ls -1 "$PATCHES_DIR"/*.patch | xargs -n1 basename | sort

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✓ Patches synced successfully!"
