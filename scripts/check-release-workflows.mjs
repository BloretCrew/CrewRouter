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
if (JSON.stringify(beta.on.push.tags) !== JSON.stringify(['v27.0.0-beta.1'])) throw new Error('beta workflow must only publish the explicitly versioned candidate tag');
const manualDryRun = beta.jobs.desktop.if?.includes('inputs.dry_run') && beta.jobs['npm-beta-candidate'].if?.includes('inputs.dry_run');
if (!manualDryRun || beta.jobs['npm-beta-candidate'].needs.join(',') !== 'gate,server,desktop') throw new Error('manual dry-run must build server, desktop and npm candidate assets from one SHA');
const prereleaseDownloadNames = beta.jobs['github-prerelease'].steps.filter(step => step.uses === 'actions/download-artifact@v4').map(step => step.with?.pattern);
if (JSON.stringify(prereleaseDownloadNames) !== JSON.stringify(['beta-server-*', 'beta-crewrouter-desktop-*'])) throw new Error('GitHub release must download only server and Desktop assets');
if (!beta.jobs['gate'].steps.some(step => step.name === 'Validate beta tag and all npm manifests' && step.run?.includes('Publishing requires dispatch from') && step.run?.includes('git rev-parse'))) throw new Error('manual publish must require the checked-out commit to match the release tag');
if (!beta.jobs['gate'].steps.some(step => step.name === 'Verify npm beta names are unclaimed' && step.if?.includes("github.event_name == 'push'"))) throw new Error('npm package ownership must be checked only on tag publish');
const desktopWorkflow = parse(await readFile(files[1], 'utf8'));
for (const event of ['push', 'pull_request']) {
  const paths = desktopWorkflow.on[event].paths || [];
  for (const required of ['cli/**', 'deploy/**']) if (!paths.includes(required)) throw new Error(`Desktop CI ${event} path filter omits ${required}`);
}
const sdkWorkflow = parse(await readFile('.github/workflows/sdk-ci.yml', 'utf8'));
for (const event of ['push', 'pull_request']) {
  const paths = sdkWorkflow.on[event].paths || [];
  for (const required of ['cli/**', 'CrewRouter-Desktop/package.json', 'server/index.js', 'server/routes/mount-loader.js']) if (!paths.includes(required)) throw new Error(`SDK CI ${event} path filter omits ${required}`);
}
if (!sdkWorkflow.jobs.contract.steps.some(step => step.run === 'npm run sdk:conformance')) throw new Error('SDK CI contract job must run cross-language conformance');
const postgresSetup = beta.jobs.gate.steps.find(step => step.name === 'Install isolated PostgreSQL test runtime');
if (!postgresSetup?.run?.includes('pg_config --bindir')) throw new Error('PostgreSQL integration tests require their isolated runner dependencies');
if (!beta.jobs['npm-beta-candidate'].steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with?.name?.startsWith('crewrouter-27-beta-npm-candidates-') && step.if?.includes("inputs.dry_run"))) throw new Error('npm beta candidate tarballs must be uploaded for dry-runs and tagged builds');
const sdkPack = beta.jobs['npm-beta-candidate'].steps.find(step => step.name === 'Build and pack SDK candidate');
if (!sdkPack?.run?.includes('cd sdk/typescript') || !sdkPack.run.includes('test -f "$RUNNER_TEMP/bloret-crew-crewrouter-sdk-${PRODUCT_VERSION}.tgz"')) throw new Error('SDK candidate must pack from sdk/typescript and verify its tarball name');
const cliPack = beta.jobs['npm-beta-candidate'].steps.find(step => step.name === 'Build and pack CLI candidate');
if (!cliPack?.run?.includes('test -f "$RUNNER_TEMP/bloret-crew-crewrouter-${PRODUCT_VERSION}.tgz"')) throw new Error('CLI candidate must verify its tarball name');
const npmPublishStep = beta.jobs['npm-beta-publish'].steps.find(step => step.name === 'Confirm npm package ownership and publish candidate packages');
if (!npmPublishStep?.run?.includes('npm publish candidates/bloret-crew-crewrouter-sdk-${PRODUCT_VERSION}.tgz') || !npmPublishStep.run.includes('npm publish candidates/bloret-crew-crewrouter-${PRODUCT_VERSION}.tgz')) throw new Error('npm publish must publish both scoped candidates');
if (!npmPublishStep.run.includes('@bloret-crew/crewrouter-sdk @bloret-crew/crewrouter')) throw new Error('npm publish must target the scoped package names');
if (!npmPublishStep.run.includes('doc.versions')) throw new Error('npm publish must check the target version is still unpublished');
const npmNameGate = beta.jobs.gate.steps.find(step => step.name === 'Verify npm beta names are unclaimed');
if (!npmNameGate?.run?.includes('doc.versions')) throw new Error('npm name gate must allow already-owned packages when the target version is new');
if (beta.jobs['github-prerelease'].needs.join(',') !== 'gate,server,desktop,npm-beta-candidate') throw new Error('GitHub release must wait for all release and candidate build gates');
const npmPublish = beta.jobs['npm-beta-publish'];
if (!npmPublish || !npmPublish.needs.includes('npm-beta-candidate') || !npmPublish.permissions?.['id-token']) throw new Error('manual npm publish must use the separately approved candidate artifact and OIDC permissions');
if (beta.jobs['npm-beta-publish'].steps.find(step => step.uses === 'actions/download-artifact@v4')?.with?.name !== 'crewrouter-27-beta-npm-candidates-${{ github.sha }}') throw new Error('npm publish must download candidate tarballs from this workflow run');
if (beta.jobs['github-release-manual'].needs.includes('npm-beta-publish') !== true) throw new Error('manual GitHub release must await npm publish if publish was explicitly selected');
const electronGate = beta.jobs.gate.steps.find(step => step.name === 'Desktop behavior, sandboxed launcher and syntax');
if (!electronGate?.run?.includes('chown root node_modules/electron/dist/chrome-sandbox') || !electronGate.run.includes('chmod 4755 node_modules/electron/dist/chrome-sandbox') || electronGate.run.includes('--no-sandbox')) throw new Error('Electron launcher gate must retain sandbox and configure the isolated SUID helper');
const stable = parse(await readFile(files[0], 'utf8'));
if (!stable.jobs['build-docker'].if?.includes("contains(github.ref, '-beta.')")) throw new Error('Stable workflow is missing prerelease protection');
console.log('release workflow YAML and sequencing contracts passed');
