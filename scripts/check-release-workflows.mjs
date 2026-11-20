import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const requireDesktop = createRequire(path.resolve('CrewRouter-Desktop/package.json'));
const { parse } = requireDesktop('yaml');

const files = [
  '.github/workflows/build-docker.yml',
  '.github/workflows/build-desktop.yml',
  '.github/workflows/beta-release.yml',
];
for (const file of files) {
  const doc = parse(await readFile(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || !doc.jobs) throw new Error(`${file} did not parse into jobs`);
}
const beta = parse(await readFile(files[2], 'utf8'));
if (beta.jobs['npm-beta-candidate'].needs.join(',') !== 'gate,server,desktop') throw new Error('npm candidate packages must wait for all same-commit build assets');
if (beta.jobs['desktop'].needs.join(',') !== 'gate' || !beta.jobs['desktop'].if?.includes('inputs.dry_run')) throw new Error('manual dry-run must produce Desktop candidate assets');
if (!beta.jobs['gate'].steps.some(step => step.name === 'Verify registry package names and release version availability' && step.if?.includes("github.event_name == 'push'"))) throw new Error('Registry package/version checks must run on tag publish, not dry-run');
if (!beta.jobs['npm-beta-candidate'].steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with?.name?.startsWith('crewrouter-27-beta-npm-candidates-'))) throw new Error('npm beta candidate tarballs must be uploaded as an artifact');
if (beta.jobs['github-prerelease'].needs.join(',') !== 'gate,server,desktop,npm-beta-candidate') throw new Error('GitHub release must wait for all build and npm candidate artifacts');
if (beta.jobs['github-prerelease'].if?.includes('workflow_dispatch')) throw new Error('manual dry-run must not create GitHub pre-releases');
const stable = parse(await readFile(files[0], 'utf8'));
if (!stable.jobs['build-docker'].if?.includes("contains(github.ref, '-beta.')")) throw new Error('Stable workflow is missing prerelease protection');
console.log('release workflow YAML and sequencing contracts passed');
