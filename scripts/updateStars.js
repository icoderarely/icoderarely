const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PLACEHOLDER_REGEX = /{{stars:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)}}/g;
const MANAGED_REGEX =
  /(\d+(?:\.\d+)?k?)\s*<!--\s*stars:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*-->/g;
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
  ".html",
]);

function formatStars(num) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(num)
    .toLowerCase();
}

function getTrackedFiles() {
  const output = execSync("git ls-files", { encoding: "utf-8" });
  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const ext = path.extname(entry).toLowerCase();
      return TEXT_EXTENSIONS.has(ext);
    });
}

function buildRepoQuery(repo, alias) {
  const [owner, name] = repo.split("/");
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount }`;
}

async function fetchStarsGraphQL(repos) {
  if (repos.length === 0) {
    return new Map();
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "Missing GITHUB_TOKEN. Set a token with repository read access.",
    );
  }

  const perRequest = 50;
  const starMap = new Map();

  for (let i = 0; i < repos.length; i += perRequest) {
    const chunk = repos.slice(i, i + perRequest);
    const aliases = chunk.map((repo, idx) => ({ repo, alias: `r${i + idx}` }));
    const query = `query {\n${aliases.map(({ repo, alias }) => buildRepoQuery(repo, alias)).join("\n")}\n}`;

    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub GraphQL request failed (${response.status}): ${body}`,
      );
    }

    const payload = await response.json();
    const aliasSet = new Set(aliases.map(({ alias }) => alias));
    const aliasErrors = new Map();
    const nonAliasErrors = [];

    for (const err of payload.errors || []) {
      const errorAlias = Array.isArray(err.path) ? err.path[0] : null;
      if (typeof errorAlias === "string" && aliasSet.has(errorAlias)) {
        aliasErrors.set(errorAlias, err.message || "Unknown repository error");
      } else {
        nonAliasErrors.push(err.message || "Unknown GraphQL error");
      }
    }

    if (nonAliasErrors.length > 0) {
      throw new Error(
        `GitHub GraphQL returned non-repository errors: ${nonAliasErrors.join(" | ")}`,
      );
    }

    for (const { repo, alias } of aliases) {
      const node = payload.data?.[alias];
      if (aliasErrors.has(alias)) {
        console.warn(`Skipped ${repo}: ${aliasErrors.get(alias)}`);
        continue;
      }
      if (!node || typeof node.stargazerCount !== "number") {
        // Keep unresolved repos out of replacement and log in caller.
        continue;
      }
      starMap.set(repo, node.stargazerCount);
    }
  }

  return starMap;
}

function collectRepos(content, filePath, foundInFiles) {
  for (const match of content.matchAll(PLACEHOLDER_REGEX)) {
    const repo = match[1];
    if (!foundInFiles.has(repo)) {
      foundInFiles.set(repo, new Set());
    }
    foundInFiles.get(repo).add(filePath);
  }

  for (const match of content.matchAll(MANAGED_REGEX)) {
    const repo = match[2];
    if (!foundInFiles.has(repo)) {
      foundInFiles.set(repo, new Set());
    }
    foundInFiles.get(repo).add(filePath);
  }
}

function applyReplacements(content, starsByRepo) {
  let next = content.replace(PLACEHOLDER_REGEX, (_whole, repo) => {
    if (!starsByRepo.has(repo)) {
      return `{{stars:${repo}}}`;
    }
    return `${formatStars(starsByRepo.get(repo))} <!--stars:${repo}-->`;
  });

  next = next.replace(MANAGED_REGEX, (_whole, _existingDisplay, repo) => {
    if (!starsByRepo.has(repo)) {
      return _whole;
    }
    return `${formatStars(starsByRepo.get(repo))} <!--stars:${repo}-->`;
  });

  return next;
}

async function main() {
  const files = getTrackedFiles();
  const fileContents = new Map();
  const reposToFiles = new Map();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    fileContents.set(file, content);
    collectRepos(content, file, reposToFiles);
  }

  const repos = Array.from(reposToFiles.keys()).sort();
  if (repos.length === 0) {
    console.log(
      "No {{stars:owner/repo}} placeholders or managed star markers found.",
    );
    return;
  }

  console.log(`Found ${repos.length} unique repositories.`);
  const starsByRepo = await fetchStarsGraphQL(repos);

  const unresolvedRepos = repos.filter((repo) => !starsByRepo.has(repo));
  if (unresolvedRepos.length > 0) {
    console.warn("Could not resolve these repositories:");
    for (const repo of unresolvedRepos) {
      const inFiles = Array.from(reposToFiles.get(repo) || []).join(", ");
      console.warn(`- ${repo} (seen in: ${inFiles})`);
    }
  }

  let changedFiles = 0;
  for (const [file, content] of fileContents) {
    const updated = applyReplacements(content, starsByRepo);
    if (updated !== content) {
      fs.writeFileSync(file, updated);
      changedFiles += 1;
      console.log(`Updated ${file}`);
    }
  }

  for (const repo of repos) {
    if (starsByRepo.has(repo)) {
      console.log(`${repo} -> ${formatStars(starsByRepo.get(repo))}`);
    }
  }

  if (changedFiles === 0) {
    console.log("No file changes were necessary.");
  } else {
    console.log(`Updated ${changedFiles} file(s).`);
  }

  if (
    unresolvedRepos.length > 0 &&
    process.env.FAIL_ON_UNRESOLVED_REPOS === "true"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Star update failed:", error);
  process.exit(1);
});
