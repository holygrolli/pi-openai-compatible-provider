import { execFileSync } from "node:child_process";

const expected = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "index.ts",
  "model-catalog.ts",
  "package.json",
];

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [result] = JSON.parse(output);
const actual = result.files.map(({ path }) => path).sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("Unexpected package contents:", { actual, expected });
  process.exit(1);
}

const forbidden = /(^|\/)(\.env|\.git|node_modules)(\/|$)/;
const privatePaths = actual.filter((path) => forbidden.test(path));
if (privatePaths.length > 0) {
  console.error("Package contains private or generated paths:", privatePaths);
  process.exit(1);
}

console.log(`Package contents verified (${actual.length} files).`);
