const fs = require("fs");

async function fetchStars(repoFull) {
  const res = await fetch(`https://api.github.com/repos/${repoFull}`);
  const data = await res.json();
  return data.stargazers_count || 0;
}

function formatStars(num) {
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return num.toString();
}

async function main() {
  let readme = fs.readFileSync("README.md", "utf-8");

  const regex = /{{stars:([^}]+)}}/g;
  const matches = [...readme.matchAll(regex)];

  for (const match of matches) {
    const repo = match[1];

    try {
      const stars = await fetchStars(repo);
      const formatted = formatStars(stars);

      readme = readme.replace(match[0], formatted);

      console.log(`${repo} → ${formatted}`);
    } catch (err) {
      console.error("Error fetching:", repo);
    }
  }

  fs.writeFileSync("README.md", readme);
}

main();
