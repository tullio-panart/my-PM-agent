import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSkills } from "../../scripts/compile-skills.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureSkills = join(projectRoot, "tests", "phase5", "fixtures", "skills");
const actualBundle = await compileSkills(join(projectRoot, "skills"));

assert.deepEqual(
  actualBundle.enabledSkills.map((skill) => skill.id),
  [
    "project-assistant",
    "meeting-analysis",
    "task-capture",
    "weekly-status",
  ],
);
assert.match(actualBundle.combinedInstructions, /# Project Assistant/);
assert.match(actualBundle.combinedInstructions, /# Meeting Analysis/);
assert.match(actualBundle.combinedInstructions, /# Task Capture/);
assert.match(actualBundle.combinedInstructions, /# Weekly Status/);
assert.match(actualBundle.sourceHash, /^[a-f0-9]{64}$/);

const fixtureBundle = await compileSkills(fixtureSkills);
assert.match(fixtureBundle.combinedInstructions, /ENABLED_SKILL_MARKER/);
assert.doesNotMatch(fixtureBundle.combinedInstructions, /DISABLED_SKILL_MARKER/);

const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-solopreneur-skills-"));
const temporarySkills = join(temporaryRoot, "skills");

try {
  await cp(fixtureSkills, temporarySkills, { recursive: true });
  const skillPath = join(temporarySkills, "enabled-example", "SKILL.md");
  const original = await readFile(skillPath, "utf8");
  await writeFile(skillPath, `${original.trim()}\n\nLEARNER_EDIT_MARKER\n`);

  const editedBundle = await compileSkills(temporarySkills);
  assert.match(editedBundle.combinedInstructions, /LEARNER_EDIT_MARKER/);
  assert.notEqual(editedBundle.sourceHash, fixtureBundle.sourceHash);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `Skill validation passed for ${actualBundle.enabledSkills.length} enabled examples.`,
);
