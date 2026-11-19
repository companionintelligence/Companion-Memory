#!/usr/bin/env bash
# Makes sure a release tag exists and points at the given commit, creating it through the API if it doesn't.
#
#   GH_TOKEN=... GH_REPO=owner/repo scripts/release/ensure-tag.sh <tag> <commit sha>
#
# Exit status: 0 the tag exists at that commit (or was just created there); 1 the tag exists at another commit;
# 3 the tag doesn't exist and couldn't be created.
#
# Why exit 3 happens: GitHub refuses to let a workflow's own token (GITHUB_TOKEN) create a ref at a commit whose
# .github/workflows files differ from the default branch's, and answers 403 "Resource not accessible by
# integration". A release tags a commit that `main` can move past while the run builds, so a workflow change merged
# meanwhile is enough. That is how desktop-v2026.11.19 failed twice (runs 44533423894 and 44541215720) after #3580
# changed two workflow files. release.yml therefore creates its tags in its first job, and anyone can push the tag
# themselves with the command this prints: a person's token may create the ref.
set -euo pipefail

tag="${1:?usage: ensure-tag.sh <tag> <commit sha>}"
sha="${2:?usage: ensure-tag.sh <tag> <commit sha>}"
repo="${GH_REPO:?set GH_REPO to owner/repo}"

if ref_json=$(gh api "repos/${repo}/git/ref/tags/${tag}" 2>/dev/null); then
  object_type=$(jq -r '.object.type' <<<"${ref_json}")
  target=$(jq -r '.object.sha' <<<"${ref_json}")
  # An annotated tag points at a tag object; the commit is behind it.
  if [[ "${object_type}" == "tag" ]]; then
    target=$(gh api "repos/${repo}/git/tags/${target}" --jq '.object.sha')
  fi
  if [[ "${target}" == "${sha}" ]]; then
    echo "${tag} already points at ${sha}."
    exit 0
  fi
  echo "::error::${tag} already exists at ${target}, not at ${sha}. Delete it or release from ${target}."
  exit 1
fi

if gh api "repos/${repo}/git/refs" -f ref="refs/tags/${tag}" -f sha="${sha}" >/dev/null; then
  echo "Created ${tag} at ${sha}."
  exit 0
fi

echo "::error::Couldn't create ${tag} at ${sha} with the workflow token. GitHub refuses that when the default branch's workflow files have changed since this commit. Push the tag yourself, then re-run this job: git tag ${tag} ${sha} && git push origin refs/tags/${tag}"
exit 3
