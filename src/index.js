const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');

const sha1 = /\b[a-f0-9]{40}\b/i;
const sha256 = /\b[A-Fa-f0-9]{64}\b/i;

let core;
let glob;

async function run() {
  try {
    core = await import('@actions/core');
    glob = await import('@actions/glob');
    await validateSubscription();
    
    const allowlist = core.getInput('allowlist');
    const isDryRun = core.getInput('dry_run') === 'true';
    let hasError = false;

    const workflowsPath = process.env['ZG_WORKFLOWS_PATH'] || '.github/workflows';
    const workflowsGlobber = await glob.create([
      workflowsPath + '/*.yaml',
      workflowsPath + '/*.yml'
    ].join('\n'));

    for await (const file of workflowsGlobber.globGenerator()) {
      const basename = path.basename(file);
      const fileContents = fs.readFileSync(file, 'utf8');
      const yamlContents = yaml.parse(fileContents);
      let fileHasError = false;

      let jobs = getYamlAttribute(yamlContents, 'jobs');
      if (jobs === undefined || jobs === null) {
        core.setFailed(`The "${basename}" workflow does not contain jobs.`);
        break;
      }

      core.startGroup(workflowsPath + '/' + basename);

      for (const job in jobs) {
        const jobObject = jobs[job];
        let jobHasError = false;
        if (jobObject === undefined || jobObject === null) {
          core.warning(`The "${job}" job of the "${basename}" workflow is undefined.`);
          jobHasError = true;
        } else {
          const uses = getYamlAttribute(jobObject, "uses");
          const steps = getYamlAttribute(jobObject, "steps");
          if (uses !== undefined && uses !== null) {
            jobHasError = runAssertions(uses, allowlist, isDryRun);
          } else if (steps !== undefined && steps !== null) {
            for (const step of steps) {
              if (!jobHasError) {
                jobHasError = runAssertions(step['uses'], allowlist, isDryRun);
              }
            }
          } else {
            core.warning(`The "${job}" job of the "${basename}" workflow does not contain uses or steps.`);
          }
        }

        if (jobHasError) {
          hasError = true;
          fileHasError = true;
        }
      }

      if (!fileHasError) {
        core.info('No issues were found.');
      }

      core.endGroup();
    }

    const actionsPath = process.env['ZG_ACTIONS_PATH'] || '.github/actions';
    const actionsGlobber = await glob.create([
      actionsPath + '/*/action.yaml',
      actionsPath + '/*/action.yml'
    ].join('\n'));

    for await (const file of actionsGlobber.globGenerator()) {
      const basename = path.basename(path.dirname(file));
      const fileContents = fs.readFileSync(file, 'utf8');
      const yamlContents = yaml.parse(fileContents);
      let fileHasError = false;

      let runs = getYamlAttribute(yamlContents, 'runs');
      if (runs === undefined || runs === null) {
        core.setFailed(`The "${basename}" action does not contain runs.`);
        break;
      }

      core.startGroup(actionsPath + '/' + basename);

      let runHasError = false;
      const steps = getYamlAttribute(runs, 'steps');
      if (steps !== undefined && steps !== null) {
        for (const step of steps) {
          if (!runHasError) {
            runHasError = runAssertions(step['uses'], allowlist, isDryRun);
          }
        }
        if (runHasError) {
          hasError = true;
          fileHasError = true;
        }
      }

      if (!fileHasError) {
        core.info('No issues were found.')
      }

      core.endGroup();
    }

    if (!isDryRun && hasError) {
      throw new Error('At least one workflow or composite action contains an unpinned GitHub Action version.');
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

function getYamlAttribute(yamlContents, attribute) {
  if (yamlContents && typeof yamlContents === 'object' && Object.prototype.hasOwnProperty.call(yamlContents, attribute)) {
    return yamlContents[attribute];
  }
  return undefined;
}

function assertUsesVersion(uses) {
  return typeof uses === 'string' && uses.includes('@');
}

function assertUsesSha(uses) {
  if (uses.startsWith('docker://')) {
    return sha256.test(uses.substr(uses.indexOf('sha256:') + 7));
  }

  return sha1.test(uses.substr(uses.indexOf('@') + 1));
}

function assertUsesAllowlist(uses, allowlist) {
  if (!allowlist) {
    return false;
  }

  const action = uses.substr(0, uses.indexOf('@'));
  const isAllowed = allowlist.split(/\r?\n/).some((allow) => action.startsWith(allow));

  if(isAllowed) {
    core.info(`${action} matched allowlist — ignoring action.`);
  }

  return isAllowed;
}

function runAssertions(uses, allowlist, isDryRun) {
  const hasError = assertUsesVersion(uses) && !assertUsesSha(uses) && !assertUsesAllowlist(uses, allowlist);

  if (hasError) {
    const message = `${uses} is not pinned to a full length commit SHA.`;

    if (isDryRun) {
      core.warning(message);
    } else {
      core.error(message);
    }
  }

  return hasError;
}

async function validateSubscription() {
  let repoPrivate;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = payload?.repository?.private;
  }

  const upstream = "zgosalvez/github-actions-ensure-sha-pinned-actions";
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl =
    "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false)
    core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) return;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const body = { action: action || "" };

  if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      );
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

