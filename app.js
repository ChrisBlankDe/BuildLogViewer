const zipInput = document.getElementById('zipInput');
const dropZone = document.getElementById('dropZone');
const headerSection = document.getElementById('headerSection');
const statusElement = document.getElementById('status');
const viewerElement = document.getElementById('viewer');
const treeElement = document.getElementById('tree');
const selectedTitle = document.getElementById('selectedTitle');
const logOutput = document.getElementById('logOutput');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const searchPrev = document.getElementById('searchPrev');
const searchNext = document.getElementById('searchNext');
const toggleTimestampsBtn = document.getElementById('toggleTimestamps');
const toggleLineWrapBtn = document.getElementById('toggleLineWrap');
const expandAllBtn = document.getElementById('expandAll');
const collapseAllBtn = document.getElementById('collapseAll');
const DEFAULT_JOB_NAME = 'Default Job';
const NORMALIZED_DEFAULT_JOB_NAME = normalizeDependencyName(DEFAULT_JOB_NAME);
const GITHUB_STAGE = 'Workflow';
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const bracketedTimePattern = /^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/;

// Azure Pipelines logging command patterns
// Reference: https://learn.microsoft.com/en-us/azure/devops/pipelines/scripts/logging-commands
// ##[command]message format
const adoErrorPattern     = /##\[error\]/i;
const adoWarningPattern   = /##\[warning\]/i;
const adoSectionPattern   = /##\[section\]/i;
const adoCommandPattern   = /##\[command\]/i;
const adoDebugPattern     = /##\[debug\]/i;
const adoInfoPattern      = /##\[info\]/i;
const adoGroupPattern     = /##\[(?:group|endgroup)\]/i;
// ##vso[task.logissue type=error|warning;...] format
const adoVsoErrorPattern   = /##vso\[task\.logissue\b[^\]]*\btype=error\b/i;
const adoVsoWarningPattern = /##vso\[task\.logissue\b[^\]]*\btype=warning\b/i;
// ##vso[task.complete|setresult result=...] format
const adoVsoSucceededPattern           = /##vso\[task\.(?:complete|setresult)\b[^\]]*\bresult=Succeeded\b/i;
const adoVsoSucceededWithIssuesPattern = /##vso\[task\.(?:complete|setresult)\b[^\]]*\bresult=SucceededWithIssues\b/i;
const adoVsoFailedPattern              = /##vso\[task\.(?:complete|setresult)\b[^\]]*\bresult=Failed\b/i;
const adoVsoSkippedPattern             = /##vso\[task\.(?:complete|setresult)\b[^\]]*\bresult=Skipped\b/i;
const adoSkippedStepPattern            = /Skipping step due to condition evaluation\./i;
const onePrefixedTaskWithInstancePattern = /^(1_.+)\s\((\d+)\)$/i;
const initializeJobTaskPattern         = /^1_initialize job$/i;

// GitHub Actions workflow command patterns
// Reference: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
const ghCommandPattern = /^\[command\]/;
const ghErrorPattern   = /^::error\b/i;
const ghWarningPattern = /^::warning\b/i;
const ghNoticePattern  = /^::notice\b/i;
const ghDebugPattern   = /^::debug\b/i;

let currentStructure = null;
let currentLogContent = '';
let searchMatches = [];
let currentMatchIndex = -1;
let showTimestamps = false;
let currentDependencyMetadata = null;
let autoLineWrap = true;
let currentActiveTreeElement = null;

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.className = isError ? 'status error' : 'status';
}

function getStageName(path) {
  const segment = path.split('/')[0] || '';
  return segment && !segment.endsWith('.txt') ? segment : 'Pipeline';
}

function getTaskName(path) {
  const fileName = path.split('/').pop() || path;
  return fileName.replace(/\.txt$/i, '');
}

function extractBaseTaskName(taskName) {
  const match = taskName.match(onePrefixedTaskWithInstancePattern);
  return match ? match[1] : null;
}

// Annotates task entries in-place to mark hidden full-job logs and display-only prepare-job logs.
function annotateSpecialJobLogs(tasks) {
  const taskNames = new Set(tasks.map((taskInfo) => taskInfo.task));
  const baseNamesWithInstances = new Set(
    tasks
      .map((taskInfo) => extractBaseTaskName(taskInfo.task))
      .filter((baseName) => baseName && taskNames.has(baseName))
  );

  for (const taskInfo of tasks) {
    const repeatedBaseName = extractBaseTaskName(taskInfo.task);
    if (baseNamesWithInstances.has(taskInfo.task)) {
      taskInfo.isAllLog = true;
      continue;
    }

    if (repeatedBaseName && baseNamesWithInstances.has(repeatedBaseName)) {
      taskInfo.isPrepareLog = true;
      taskInfo.displayTask = '0_Prepare job';
    }
  }
}

function sortTaskInfos(tasks) {
  const PRIORITY_PREPARE = 0;
  const PRIORITY_INITIALIZE = 1;
  const PRIORITY_REGULAR = 2;
  const getPriority = (taskInfo) => {
    if (taskInfo.isPrepareLog) return PRIORITY_PREPARE;
    if (initializeJobTaskPattern.test(taskInfo.task)) return PRIORITY_INITIALIZE;
    return PRIORITY_REGULAR;
  };

  tasks.sort((a, b) => {
    const leftPriority = getPriority(a);
    const rightPriority = getPriority(b);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return a.task.localeCompare(b.task, undefined, { numeric: true });
  });
}

function parseTopLevelPipelineLogJobName(path) {
  const segments = path.split('/');
  if (segments.length !== 1) return null;

  const fileName = segments[0] || '';
  if (!fileName.toLowerCase().endsWith('.txt')) return null;

  const taskName = getTaskName(fileName);
  // Matches top-level pipeline logs like "1_JobName" and "1_JobName (1)".
  const match = taskName.match(/^\d+_(.+?)(?:\s\(\d+\))?$/);
  return match ? match[1] : null;
}

function getJobName(segments, pipelineInitializationJob) {
  // "<stage>/<task>.txt" and mapped top-level pipeline logs are grouped under "Default Job".
  // "<stage>/<job>/<task>.txt" keeps the explicit nested job segment.
  if (segments.length > 1) {
    return segments.length > 2 ? segments[1] : DEFAULT_JOB_NAME;
  }
  return pipelineInitializationJob ? DEFAULT_JOB_NAME : 'Pipeline Logs';
}

function stageSort(left, right) {
  if (left === 'Pipeline') return -1;
  if (right === 'Pipeline') return 1;
  return left.localeCompare(right);
}

function detectProvider(zip) {
  const fileNames = Object.keys(zip.files);
  const isAdo = fileNames.some((name) =>
    name.startsWith('Agent Diagnostic Logs/') ||
    name.toLowerCase().endsWith('azure-pipelines-expanded.yaml')
  );
  return isAdo ? 'ado' : 'github';
}

function normalizeDependencyName(value) {
  return (value || '').trim().toLowerCase();
}

// Returns YAML indentation width by finding the first non-whitespace character.
function getIndentationLength(line) {
  return line.search(/\S|$/);
}

function stripYamlQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDependsOnValue(lines, lineIndex, initialValue, baseIndent) {
  const trimmedInitialValue = initialValue.trim();

  if (!trimmedInitialValue) {
    const dependencies = [];
    let nextIndex = lineIndex + 1;
    while (nextIndex < lines.length) {
      const line = lines[nextIndex];
      const indent = getIndentationLength(line);
      const itemMatch = line.match(/^\s*-\s*(.+)\s*$/);
      if (indent < baseIndent) break;
      if (indent === baseIndent && !itemMatch) break;
      if (itemMatch) {
        dependencies.push(stripYamlQuotes(itemMatch[1]));
      }
      nextIndex++;
    }
    return { dependencies, nextIndex };
  }

  if (trimmedInitialValue === '[]') {
    return { dependencies: [], nextIndex: lineIndex + 1 };
  }

  if (trimmedInitialValue.startsWith('[') && trimmedInitialValue.endsWith(']')) {
    const list = trimmedInitialValue.slice(1, -1).trim();
    const dependencies = list
      ? list.split(',').map((item) => stripYamlQuotes(item)).filter(Boolean)
      : [];
    return { dependencies, nextIndex: lineIndex + 1 };
  }

  return { dependencies: [stripYamlQuotes(trimmedInitialValue)], nextIndex: lineIndex + 1 };
}

function parseExpandedPipelineYaml(yamlText) {
  const lines = yamlText.split('\n');
  const stages = [];
  let inStagesSection = false;
  let stagesIndent = -1;
  let currentStage = null;
  let currentJob = null;
  let jobsIndent = -1;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const indent = getIndentationLength(line);
    const trimmed = line.trim();

    if (!inStagesSection) {
      if (trimmed === 'stages:') {
        inStagesSection = true;
        stagesIndent = indent;
      }
      index++;
      continue;
    }

    const stageMatch = line.match(/^\s*-\s+stage:\s*(.+)\s*$/);
    if (stageMatch && indent === stagesIndent) {
      currentStage = {
        id: stripYamlQuotes(stageMatch[1]),
        displayName: '',
        dependsOn: [],
        jobs: [],
      };
      stages.push(currentStage);
      currentJob = null;
      jobsIndent = -1;
      index++;
      continue;
    }

    if (!currentStage) {
      index++;
      continue;
    }

    if (indent === 0 && trimmed && !trimmed.startsWith('-')) {
      break;
    }

    if (trimmed === 'jobs:') {
      jobsIndent = indent;
      currentJob = null;
      index++;
      continue;
    }

    if (jobsIndent >= 0) {
      const jobMatch = line.match(/^\s*-\s+job:\s*(.+)\s*$/);
      if (jobMatch && indent === jobsIndent) {
        currentJob = {
          id: stripYamlQuotes(jobMatch[1]),
          displayName: '',
          dependsOn: [],
        };
        currentStage.jobs.push(currentJob);
        index++;
        continue;
      }
    }

    const displayNameMatch = line.match(/^\s*displayName:\s*(.+)\s*$/);
    if (displayNameMatch) {
      if (currentJob && jobsIndent >= 0 && indent === jobsIndent + 2) {
        currentJob.displayName = stripYamlQuotes(displayNameMatch[1]);
      } else if (indent > 0 && (jobsIndent < 0 || indent <= jobsIndent)) {
        currentStage.displayName = stripYamlQuotes(displayNameMatch[1]);
      }
      index++;
      continue;
    }

    const dependsOnMatch = line.match(/^(\s*)dependsOn:\s*(.*)$/);
    if (dependsOnMatch) {
      const dependsOnIndent = dependsOnMatch[1].length;
      const { dependencies, nextIndex } = parseDependsOnValue(lines, index, dependsOnMatch[2], dependsOnIndent);
      if (currentJob && jobsIndent >= 0 && dependsOnIndent === jobsIndent + 2) {
        currentJob.dependsOn = dependencies;
      } else {
        currentStage.dependsOn = dependencies;
      }
      index = nextIndex;
      continue;
    }

    index++;
  }

  return { stages };
}

// Topologically sorts names using dependency edges; falls back to compareFallback order for cycles/unknown edges.
function topologicalSortNames(names, getDependencies, compareFallback) {
  const uniqueNames = [...new Set(names)];
  const fallbackOrder = [...uniqueNames].sort(compareFallback);
  const orderMap = new Map(fallbackOrder.map((name, index) => [name, index]));
  const adjacency = new Map(uniqueNames.map((name) => [name, new Set()]));
  const indegree = new Map(uniqueNames.map((name) => [name, 0]));

  for (const name of uniqueNames) {
    const dependencies = getDependencies(name) || [];
    for (const dependency of dependencies) {
      if (dependency === name) continue;
      if (!indegree.has(dependency)) continue;
      const dependents = adjacency.get(dependency);
      if (dependents.has(name)) continue;
      dependents.add(name);
      indegree.set(name, indegree.get(name) + 1);
    }
  }

  const queue = fallbackOrder.filter((name) => indegree.get(name) === 0);
  const result = [];

  while (queue.length > 0) {
    queue.sort((left, right) => orderMap.get(left) - orderMap.get(right));
    const current = queue.shift();
    result.push(current);

    for (const dependent of adjacency.get(current)) {
      const nextIndegree = indegree.get(dependent) - 1;
      indegree.set(dependent, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (result.length !== uniqueNames.length) {
    const resultSet = new Set(result);
    for (const name of fallbackOrder) {
      if (!resultSet.has(name)) {
        result.push(name);
        resultSet.add(name);
      }
    }
  }

  return result;
}

function getStageAliases(stageDefinition) {
  const aliases = [stageDefinition.id, stageDefinition.displayName];
  for (const jobDefinition of stageDefinition.jobs) {
    aliases.push(jobDefinition.id, jobDefinition.displayName);
  }
  return aliases.map(normalizeDependencyName).filter(Boolean);
}

function findStageDefinition(stageName, stageDefinitions) {
  const normalizedStageName = normalizeDependencyName(stageName);
  return stageDefinitions.find((stageDefinition) => getStageAliases(stageDefinition).includes(normalizedStageName)) || null;
}

function getJobAliases(jobDefinition) {
  return [jobDefinition.id, jobDefinition.displayName].map(normalizeDependencyName).filter(Boolean);
}

function findJobDefinition(jobName, jobDefinitions) {
  const normalizedJobName = normalizeDependencyName(jobName);
  const directMatch = jobDefinitions.find((jobDefinition) => getJobAliases(jobDefinition).includes(normalizedJobName));
  if (directMatch) return directMatch;
  if (normalizedJobName === NORMALIZED_DEFAULT_JOB_NAME && jobDefinitions.length === 1) {
    return jobDefinitions[0];
  }
  return null;
}

function getResolvedJobNameFromMetadata(stageName, fallbackJobName) {
  if (fallbackJobName !== DEFAULT_JOB_NAME) return fallbackJobName;
  if (!currentDependencyMetadata?.stages?.length) return fallbackJobName;

  const stageDefinition = findStageDefinition(stageName, currentDependencyMetadata.stages);
  const stageJobs = stageDefinition?.jobs;
  if (!stageJobs?.length) return fallbackJobName;
  if (stageJobs.length === 1) return stageJobs[0].id || fallbackJobName;

  const normalizedStageName = normalizeDependencyName(stageName);
  const matchingJob = stageJobs.find((jobDefinition) => getJobAliases(jobDefinition).includes(normalizedStageName));
  return matchingJob?.id || fallbackJobName;
}

function sortStageNamesByDependencies(stageNames) {
  if (!currentDependencyMetadata?.stages?.length) {
    return [...stageNames].sort(stageSort);
  }

  const stageDefinitions = currentDependencyMetadata.stages;
  const stageNameToDefinition = new Map();
  for (const stageName of stageNames) {
    const stageDefinition = findStageDefinition(stageName, stageDefinitions);
    if (stageDefinition) {
      stageNameToDefinition.set(stageName, stageDefinition);
    }
  }

  const definitionIdToStageName = new Map();
  for (const [stageName, stageDefinition] of stageNameToDefinition.entries()) {
    if (!definitionIdToStageName.has(stageDefinition.id)) {
      definitionIdToStageName.set(stageDefinition.id, stageName);
    }
  }

  return topologicalSortNames(
    stageNames,
    (stageName) => {
      const stageDefinition = stageNameToDefinition.get(stageName);
      if (!stageDefinition) return [];
      return stageDefinition.dependsOn.map((dependencyId) => definitionIdToStageName.get(dependencyId)).filter(Boolean);
    },
    stageSort
  );
}

function sortJobNamesByDependencies(stageName, jobNames) {
  const fallbackSort = (left, right) => left.localeCompare(right, undefined, { numeric: true });
  if (!currentDependencyMetadata?.stages?.length) {
    return [...jobNames].sort(fallbackSort);
  }

  const stageDefinition = findStageDefinition(stageName, currentDependencyMetadata.stages);
  if (!stageDefinition || stageDefinition.jobs.length === 0) {
    return [...jobNames].sort(fallbackSort);
  }

  const jobNameToDefinition = new Map();
  for (const jobName of jobNames) {
    const jobDefinition = findJobDefinition(jobName, stageDefinition.jobs);
    if (jobDefinition) {
      jobNameToDefinition.set(jobName, jobDefinition);
    }
  }

  const definitionIdToJobName = new Map();
  for (const [jobName, jobDefinition] of jobNameToDefinition.entries()) {
    if (!definitionIdToJobName.has(jobDefinition.id)) {
      definitionIdToJobName.set(jobDefinition.id, jobName);
    }
  }

  return topologicalSortNames(
    jobNames,
    (jobName) => {
      const jobDefinition = jobNameToDefinition.get(jobName);
      if (!jobDefinition) return [];
      return jobDefinition.dependsOn.map((dependencyId) => definitionIdToJobName.get(dependencyId)).filter(Boolean);
    },
    fallbackSort
  );
}

function analyzeLogContent(text) {
  const lines = text.split('\n');
  let hasErrors = false;
  let hasWarnings = false;
  let isSkipped = false;

  for (const line of lines) {
    if (!hasErrors && (adoErrorPattern.test(line) || adoVsoErrorPattern.test(line) || adoVsoFailedPattern.test(line))) {
      hasErrors = true;
    }
    if (!hasWarnings && (adoWarningPattern.test(line) || adoVsoWarningPattern.test(line) || adoVsoSucceededWithIssuesPattern.test(line))) {
      hasWarnings = true;
    }
    if (!isSkipped && (adoVsoSkippedPattern.test(line) || adoSkippedStepPattern.test(line))) {
      isSkipped = true;
    }
    if (!hasErrors || !hasWarnings) {
      const stripped = removeTimestampPrefix(line).trimStart();
      if (!hasErrors && ghErrorPattern.test(stripped)) hasErrors = true;
      if (!hasWarnings && ghWarningPattern.test(stripped)) hasWarnings = true;
    }
    if (hasErrors && hasWarnings && isSkipped) break;
  }

  return { hasErrors, hasWarnings, isSkipped };
}

function highlightLogLine(line) {
  // ##[error], ##vso[task.logissue type=error;...], or failed task result
  if (adoErrorPattern.test(line) || adoVsoErrorPattern.test(line) || adoVsoFailedPattern.test(line)) {
    return 'error';
  }

  // ##[warning], ##vso[task.logissue type=warning;...], or SucceededWithIssues task result
  if (adoWarningPattern.test(line) || adoVsoWarningPattern.test(line) || adoVsoSucceededWithIssuesPattern.test(line)) {
    return 'warning';
  }

  // ##vso[task.complete|setresult result=Succeeded]
  if (adoVsoSucceededPattern.test(line)) {
    return 'success';
  }

  // ##[section] — collapsible log section header
  if (adoSectionPattern.test(line)) {
    return 'section';
  }

  // ##[command] — command being executed (ADO)
  if (adoCommandPattern.test(line)) {
    return 'command';
  }

  // ##[debug] — debug output
  if (adoDebugPattern.test(line)) {
    return 'debug';
  }

  // ##[info] — informational output
  if (adoInfoPattern.test(line)) {
    return 'info';
  }

  // ##[group] / ##[endgroup] — log group delimiter
  if (adoGroupPattern.test(line)) {
    return 'group';
  }

  // GitHub Actions patterns — match on content after stripping timestamp prefix
  const stripped = removeTimestampPrefix(line).trimStart();
  if (ghCommandPattern.test(stripped)) return 'command';
  if (ghErrorPattern.test(stripped)) return 'error';
  if (ghWarningPattern.test(stripped)) return 'warning';
  if (ghNoticePattern.test(stripped)) return 'info';
  if (ghDebugPattern.test(stripped)) return 'debug';

  // Plain timestamp lines (no special marker)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line) || /^\[\d{2}:\d{2}:\d{2}\]/.test(line)) {
    return 'timestamp';
  }

  return '';
}

function removeTimestampPrefix(line) {
  return line
    .replace(/^\uFEFF/, '')
    .replace(isoTimestampPattern, '')
    .replace(bracketedTimePattern, '');
}

function formatLogWithHighlighting(text) {
  const lines = text.split(/\r?\n/);
  const root = { type: 'root', children: [] };
  const stack = [root];

  function appendLine(lineText, lineNumber) {
    const displayLine = showTimestamps ? lineText : removeTimestampPrefix(lineText);
    const className = highlightLogLine(displayLine);
    const classSuffix = className ? ` ${className}` : '';
    stack[stack.length - 1].children.push({
      type: 'line',
      html: `<span class="log-line${classSuffix}" data-line-number="${lineNumber}">${escapeHtml(displayLine)}</span>`,
    });
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const stripped = removeTimestampPrefix(line).trimStart();
    if (/^##\[group\]/.test(stripped)) {
      const displayLine = showTimestamps ? line : removeTimestampPrefix(line);
      const displayText = displayLine.trimStart();
      const groupNode = {
        type: 'group',
        summaryHtml: `<span class="log-line log-group-summary group" data-line-number="${lineNumber}"><span class="log-group-toggle">▶</span>${escapeHtml(displayText)}</span>`,
        children: [],
      };
      stack[stack.length - 1].children.push(groupNode);
      stack.push(groupNode);
      return;
    }

    if (/^##\[endgroup\]\s*$/.test(stripped)) {
      const displayLine = showTimestamps ? line : removeTimestampPrefix(line);
      const displayText = displayLine.trimStart();
      stack[stack.length - 1].children.push({
        type: 'line',
        html: `<span class="log-line group" data-line-number="${lineNumber}">${escapeHtml(displayText)}</span>`,
      });
      if (stack.length > 1) {
        stack.pop();
      }
      return;
    }

    appendLine(line, lineNumber);
  });

  function renderNodes(nodes) {
    return nodes.map((node) => {
      if (node.type === 'line') return node.html;
      return [
        '<details class="log-group" open>',
        `<summary>${node.summaryHtml}</summary>`,
        `<div class="log-group-content">${renderNodes(node.children)}</div>`,
        '</details>',
      ].join('');
    }).join('');
  }

  return renderNodes(root.children);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function buildAdoStructure(zip) {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.txt'));
  const structure = new Map();
  currentDependencyMetadata = null;

  const pipelineYamlEntry = Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith('azure-pipelines-expanded.yaml'));
  if (pipelineYamlEntry) {
    try {
      const yamlText = await pipelineYamlEntry.async('string');
      currentDependencyMetadata = parseExpandedPipelineYaml(yamlText);
    } catch (error) {
      console.warn('Unable to parse dependency metadata from azure-pipelines-expanded.yaml', error);
    }
  }

  for (const entry of entries) {
    const path = entry.name;
    if (path.startsWith('Agent Diagnostic Logs/')) {
      continue;
    }

    const segments = path.split('/');
    const hasFolders = segments.length > 1;
    const pipelineInitializationJob = parseTopLevelPipelineLogJobName(path);
    if (!hasFolders && !pipelineInitializationJob) {
      // Skip top-level logs that cannot be mapped as job initializations.
      continue;
    }
    const stage = pipelineInitializationJob || getStageName(path);
    const relative = hasFolders ? segments.slice(1).join('/') : path;
    const job = getResolvedJobNameFromMetadata(stage, getJobName(segments, pipelineInitializationJob));
    const task = getTaskName(relative);

    // Read log content to analyze status
    const logText = await entry.async('string');
    const analysis = analyzeLogContent(logText);

    if (!structure.has(stage)) {
      structure.set(stage, new Map());
    }

    const jobs = structure.get(stage);
    if (!jobs.has(job)) {
      jobs.set(job, []);
    }

    jobs.get(job).push({
      task,
      path,
      entry,
      hasErrors: analysis.hasErrors,
      hasWarnings: analysis.hasWarnings,
      isSkipped: analysis.isSkipped,
    });
  }

  for (const jobs of structure.values()) {
    for (const tasks of jobs.values()) {
      annotateSpecialJobLogs(tasks);
      sortTaskInfos(tasks);
    }
  }

  return structure;
}

async function buildGithubStructure(zip) {
  const structure = new Map();
  currentDependencyMetadata = null;

  // Collect root-level aggregate logs (n_JobName.txt) and per-step logs (JobName/n_StepName.txt).
  const rootLogs = new Map();
  const stepLogs = new Map();

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.toLowerCase().endsWith('.txt')) continue;
    const segments = entry.name.split('/');
    if (segments.length === 1) {
      const match = segments[0].match(/^\d+_(.+)\.txt$/i);
      if (match) rootLogs.set(match[1], { fileName: segments[0], entry });
    } else if (segments.length === 2) {
      const [jobDir, fileName] = segments;
      if (fileName.toLowerCase() === 'system.txt') continue;
      if (!/^\d+_.+\.txt$/i.test(fileName)) continue;
      if (!stepLogs.has(jobDir)) stepLogs.set(jobDir, []);
      stepLogs.get(jobDir).push({ fileName, entry });
    }
  }

  const allJobNames = new Set([...rootLogs.keys(), ...stepLogs.keys()]);
  if (allJobNames.size === 0) return structure;

  // Determine display order from the numeric prefix of each root aggregate file.
  const jobOrder = new Map();
  for (const [jobName, { fileName }] of rootLogs.entries()) {
    const numMatch = fileName.match(/^(\d+)_/);
    if (numMatch) jobOrder.set(jobName, parseInt(numMatch[1], 10));
  }
  const sortedJobNames = [...allJobNames].sort((a, b) => {
    const orderA = jobOrder.get(a) ?? Infinity;
    const orderB = jobOrder.get(b) ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return a.localeCompare(b);
  });

  structure.set(GITHUB_STAGE, new Map());
  const jobs = structure.get(GITHUB_STAGE);

  for (const jobName of sortedJobNames) {
    jobs.set(jobName, []);
    const tasks = jobs.get(jobName);

    // Add individual step logs.
    const steps = stepLogs.get(jobName) || [];
    for (const step of steps) {
      const logText = await step.entry.async('string');
      const analysis = analyzeLogContent(logText);
      tasks.push({
        task: step.fileName.replace(/\.txt$/i, ''),
        path: `${jobName}/${step.fileName}`,
        entry: step.entry,
        hasErrors: analysis.hasErrors,
        hasWarnings: analysis.hasWarnings,
        isSkipped: analysis.isSkipped,
      });
    }

    // Add aggregate log, marking it as [all] only when individual steps are also present.
    const rootLog = rootLogs.get(jobName);
    if (rootLog) {
      const logText = await rootLog.entry.async('string');
      const analysis = analyzeLogContent(logText);
      tasks.push({
        task: rootLog.fileName.replace(/\.txt$/i, ''),
        path: rootLog.fileName,
        entry: rootLog.entry,
        hasErrors: analysis.hasErrors,
        hasWarnings: analysis.hasWarnings,
        isSkipped: analysis.isSkipped,
        isAllLog: steps.length > 0,
      });
    }

    sortTaskInfos(tasks);
  }

  return structure;
}

async function buildStructure(file) {
  const zip = await JSZip.loadAsync(file);
  const provider = detectProvider(zip);
  if (provider === 'ado') {
    return buildAdoStructure(zip);
  }
  return buildGithubStructure(zip);
}

async function selectTask(taskInfo, activeElement) {
  if (currentActiveTreeElement) {
    currentActiveTreeElement.classList.remove('active');
  }
  activeElement.classList.add('active');
  currentActiveTreeElement = activeElement;

  selectedTitle.textContent = taskInfo.path;
  logOutput.innerHTML = '<span class="log-line">Loading log...</span>';

  const text = await taskInfo.entry.async('string');
  currentLogContent = text;
  displayLog(text);

  // Clear search when switching logs
  searchInput.value = '';
  clearSearch();
}

function createTaskItem(taskInfo) {
  const listItem = document.createElement('li');
  const button = document.createElement('button');
  button.className = 'tree-item';
  
  // Add status classes
  if (taskInfo.hasErrors) {
    button.classList.add('has-errors');
  } else if (taskInfo.hasWarnings) {
    button.classList.add('has-warnings');
  } else if (taskInfo.isSkipped) {
    button.classList.add('skipped');
  } else {
    button.classList.add('success');
  }
  
  button.type = 'button';
  button.textContent = taskInfo.displayTask || taskInfo.task;

  button.addEventListener('click', async () => {
    await selectTask(taskInfo, button);
  });

  listItem.appendChild(button);
  return listItem;
}

function displayLog(text) {
  if (!text) {
    logOutput.innerHTML = '<span class="log-line">(empty log)</span>';
    return;
  }
  logOutput.innerHTML = formatLogWithHighlighting(text);
}

function createCollapsibleNode(label, type) {
  const container = document.createElement('div');
  container.className = 'tree-node';
  
  const toggle = document.createElement('button');
  toggle.className = 'tree-toggle expanded';
  toggle.textContent = '▶';
  toggle.type = 'button';
  
  const labelSpan = document.createElement('span');
  labelSpan.className = 'tree-label';
  labelSpan.textContent = `${type}: ${label}`;
  
  container.appendChild(toggle);
  container.appendChild(labelSpan);
  
  return { container, toggle, labelSpan };
}

function renderStructure(structure) {
  treeElement.innerHTML = '';
  currentStructure = structure;
  currentActiveTreeElement = null;

  const sortedStages = sortStageNamesByDependencies([...structure.keys()]);
  for (const stageName of sortedStages) {
    const stageItem = document.createElement('li');
    const { container: stageNode, toggle: stageToggle, labelSpan: stageLabel } = createCollapsibleNode(stageName, 'Stage');
    stageItem.appendChild(stageNode);

    const jobsList = document.createElement('ul');
    const jobs = structure.get(stageName);
    const sortedJobNames = sortJobNamesByDependencies(stageName, [...jobs.keys()]);
    for (const jobName of sortedJobNames) {
      const tasks = jobs.get(jobName);
      const jobItem = document.createElement('li');
      const { container: jobNode, toggle: jobToggle, labelSpan: jobLabel } = createCollapsibleNode(jobName, 'Job');
      jobItem.appendChild(jobNode);

      const tasksList = document.createElement('ul');
      const allTaskInfo = tasks.find((taskInfo) => taskInfo.isAllLog);
      const visibleTasks = tasks.filter((taskInfo) => !taskInfo.isAllLog);
      for (const taskInfo of visibleTasks) {
        tasksList.appendChild(createTaskItem(taskInfo));
      }
      if (allTaskInfo) {
        const allLink = document.createElement('button');
        allLink.type = 'button';
        allLink.className = 'tree-inline-link';
        allLink.textContent = '[all]';
        allLink.addEventListener('click', async (event) => {
          event.stopPropagation();
          await selectTask(allTaskInfo, allLink);
        });
        jobLabel.appendChild(document.createTextNode(' '));
        jobLabel.appendChild(allLink);
      }

      const toggleJob = () => {
        jobToggle.classList.toggle('expanded');
        tasksList.classList.toggle('hidden');
      };
      jobToggle.addEventListener('click', toggleJob);
      jobLabel.addEventListener('click', toggleJob);

      jobItem.appendChild(tasksList);
      jobsList.appendChild(jobItem);
    }

    const toggleStage = () => {
      stageToggle.classList.toggle('expanded');
      jobsList.classList.toggle('hidden');
    };
    stageToggle.addEventListener('click', toggleStage);
    stageLabel.addEventListener('click', toggleStage);

    stageItem.appendChild(jobsList);
    treeElement.appendChild(stageItem);
  }
}

function expandAll() {
  document.querySelectorAll('.tree-toggle').forEach(toggle => {
    toggle.classList.add('expanded');
  });
  document.querySelectorAll('.tree ul').forEach(ul => {
    ul.classList.remove('hidden');
  });
}

function collapseAll() {
  document.querySelectorAll('.tree-toggle').forEach(toggle => {
    toggle.classList.remove('expanded');
  });
  document.querySelectorAll('.tree ul').forEach(ul => {
    ul.classList.add('hidden');
  });
}

function performSearch() {
  const query = searchInput.value.trim();
  clearSearch();
  
  if (!query || !currentLogContent) {
    return;
  }
  
  const lines = logOutput.querySelectorAll('.log-line');
  searchMatches = [];
  
  lines.forEach((line, index) => {
    const text = line.textContent;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    if (lowerText.includes(lowerQuery)) {
      searchMatches.push({ element: line, index });
    }
  });
  
  if (searchMatches.length > 0) {
    highlightMatches(query);
    currentMatchIndex = 0;
    scrollToMatch(0);
    updateSearchUI();
  } else {
    searchCount.textContent = 'No matches';
  }
}

function highlightMatches(query) {
  const lowerQuery = query.toLowerCase();
  
  searchMatches.forEach(({ element }) => {
    const text = element.textContent;
    const lowerText = text.toLowerCase();
    let lastIndex = 0;
    let newHTML = '';
    
    let index = lowerText.indexOf(lowerQuery);
    while (index !== -1) {
      newHTML += escapeHtml(text.substring(lastIndex, index));
      newHTML += `<span class="highlight-match">${escapeHtml(text.substring(index, index + query.length))}</span>`;
      lastIndex = index + query.length;
      index = lowerText.indexOf(lowerQuery, lastIndex);
    }
    newHTML += escapeHtml(text.substring(lastIndex));
    
    // Preserve the line's class
    const className = element.className;
    element.innerHTML = newHTML;
    element.className = className;
  });
}

function scrollToMatch(index) {
  if (index < 0 || index >= searchMatches.length) return;
  
  // Remove current highlight
  document.querySelectorAll('.highlight-current').forEach(el => {
    el.classList.remove('highlight-current');
    el.classList.add('highlight-match');
  });
  
  // Add current highlight
  const match = searchMatches[index];
  let parent = match.element.parentElement;
  while (parent) {
    if (parent.tagName === 'DETAILS') {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
  const highlights = match.element.querySelectorAll('.highlight-match');
  if (highlights.length > 0) {
    highlights[0].classList.remove('highlight-match');
    highlights[0].classList.add('highlight-current');
  }
  
  match.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateSearchUI() {
  if (searchMatches.length === 0) {
    searchCount.textContent = '';
    searchPrev.disabled = true;
    searchNext.disabled = true;
  } else {
    searchCount.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
    searchPrev.disabled = currentMatchIndex <= 0;
    searchNext.disabled = currentMatchIndex >= searchMatches.length - 1;
  }
}

function updateTimestampToggleButton() {
  toggleTimestampsBtn.textContent = showTimestamps ? 'Hide Timestamps' : 'Show Timestamps';
  toggleTimestampsBtn.title = showTimestamps ? 'Hide timestamps' : 'Show timestamps';
  toggleTimestampsBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
}

function updateLineWrapToggleButton() {
  toggleLineWrapBtn.textContent = autoLineWrap ? 'Disable Wrap' : 'Enable Wrap';
  toggleLineWrapBtn.title = autoLineWrap ? 'Disable automatic line wrapping' : 'Enable automatic line wrapping';
  toggleLineWrapBtn.setAttribute('aria-pressed', autoLineWrap ? 'true' : 'false');
}

function applyLogLineWrap() {
  logOutput.classList.toggle('no-wrap', !autoLineWrap);
}

function clearSearch() {
  searchMatches = [];
  currentMatchIndex = -1;
  updateSearchUI();
  
  // Restore original content
  if (currentLogContent) {
    displayLog(currentLogContent);
  }
}

// Drag and Drop handlers
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  
  const files = e.dataTransfer.files;
  if (files.length > 0 && files[0].name.endsWith('.zip')) {
    zipInput.files = files;
    handleFileUpload(files[0]);
  } else {
    dropZone.classList.remove('minimized');
    setStatus('Please drop a valid ZIP file.', true);
  }
});

async function handleFileUpload(file) {
  viewerElement.classList.add('hidden');
  selectedTitle.textContent = 'Log Output';
  logOutput.innerHTML = '<span class="log-line">Select a task to view its log output.</span>';
  currentLogContent = '';
  clearSearch();

  if (!file) {
    headerSection.classList.remove('hidden');
    setStatus('');
    return;
  }

  setStatus('Reading zip file...');

  try {
    const structure = await buildStructure(file);
    if (structure.size === 0) {
      headerSection.classList.remove('hidden');
      dropZone.classList.remove('minimized');
      setStatus('No supported .txt log files were found in this ZIP.', true);
      return;
    }

    renderStructure(structure);
    viewerElement.classList.remove('hidden');
    dropZone.classList.add('minimized');
    headerSection.classList.add('hidden');
    setStatus('');
  } catch (error) {
    console.error(error);
    headerSection.classList.remove('hidden');
    dropZone.classList.remove('minimized');
    setStatus('Failed to read ZIP file. Please upload a valid Azure Pipelines or GitHub Actions log ZIP.', true);
  }
}

// Event Listeners
zipInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  await handleFileUpload(file);
});

expandAllBtn.addEventListener('click', expandAll);
collapseAllBtn.addEventListener('click', collapseAll);

searchInput.addEventListener('input', performSearch);
searchPrev.addEventListener('click', () => {
  if (currentMatchIndex > 0) {
    currentMatchIndex--;
    scrollToMatch(currentMatchIndex);
    updateSearchUI();
  }
});

searchNext.addEventListener('click', () => {
  if (currentMatchIndex < searchMatches.length - 1) {
    currentMatchIndex++;
    scrollToMatch(currentMatchIndex);
    updateSearchUI();
  }
});

toggleTimestampsBtn.addEventListener('click', () => {
  showTimestamps = !showTimestamps;
  updateTimestampToggleButton();

  if (searchInput.value.trim()) {
    performSearch();
  } else if (currentLogContent) {
    displayLog(currentLogContent);
  }
});

toggleLineWrapBtn.addEventListener('click', () => {
  autoLineWrap = !autoLineWrap;
  applyLogLineWrap();
  updateLineWrapToggleButton();
});

updateTimestampToggleButton();
updateLineWrapToggleButton();
applyLogLineWrap();
