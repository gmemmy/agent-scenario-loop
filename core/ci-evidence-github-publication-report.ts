import {
  evaluateCiEvidenceGithubPublicationGate,
  type CiEvidenceGithubPublicationGateResult,
} from './ci-evidence-github-publication-gate';
import type {
  CiEvidencePack,
  CiEvidencePackAttemptRecord,
  CiEvidencePackPlatform,
} from './ci-evidence-pack';
import type {
  CiEvidencePublicationItemOutcome,
  CiEvidencePublicationReceipt,
  CiEvidencePublicationRequestedItem,
} from './ci-evidence-publication-receipt';

export interface CiEvidenceGithubPublicationReport {
  readonly gate: CiEvidenceGithubPublicationGateResult;
  readonly markdown: string;
}

const PLATFORMS: readonly CiEvidencePackPlatform[] = ['android', 'ios'];

function compareUtf16(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isUntrustedControlOrFormatChar(code: number): boolean {
  const isC0 = code <= 0x1f;
  const isDel = code === 0x7f;
  const isC1 = code >= 0x80 && code <= 0x9f;
  const isLineSeparator = code === 0x2028 || code === 0x2029;
  const isNbsp = code === 0xa0;
  const isArabicLetterMark = code === 0x061c;
  const isZeroWidth = code >= 0x200b && code <= 0x200d;
  const isWordJoiner = code === 0x2060;
  const isInvisibleMathOp = code >= 0x2061 && code <= 0x2064;
  const isVariationSelector =
    (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
  const isInhibitFormat = code >= 0x206a && code <= 0x206f;
  const isSoftHyphen = code === 0xad;
  const isUnicodeSpace =
    (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
  const isTag = code >= 0xe0000 && code <= 0xe007f;
  const isBom = code === 0xfeff;
  const isBidi =
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069);
  return (
    isC0 ||
    isDel ||
    isC1 ||
    isLineSeparator ||
    isNbsp ||
    isArabicLetterMark ||
    isZeroWidth ||
    isWordJoiner ||
    isInvisibleMathOp ||
    isVariationSelector ||
    isInhibitFormat ||
    isSoftHyphen ||
    isUnicodeSpace ||
    isTag ||
    isBom ||
    isBidi
  );
}

function foldUntrustedText(value: string): string {
  let folded = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isUntrustedControlOrFormatChar(code)) {
      folded += ' ';
      continue;
    }
    folded += char;
  }
  return folded.replace(/[ \t]+/g, ' ').trim();
}

function neutralizeBareAutolinkText(value: string): string {
  return value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\/\//g, '$1: //')
    .replace(/www\./gi, 'www .')
    .replace(/@/g, ' @ ');
}

function escapeMarkdownPlain(value: string): string {
  const folded = neutralizeBareAutolinkText(foldUntrustedText(value));
  return folded
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/!/g, '\\!')
    .replace(/\|/g, '\\|');
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownPlain(value);
}

function isMarkdownSafeUrlDestination(urlValue: string): boolean {
  if (typeof urlValue !== 'string' || urlValue.length === 0) {
    return false;
  }
  for (const char of urlValue) {
    const code = char.codePointAt(0) ?? 0;
    if (isUntrustedControlOrFormatChar(code) || /\s/.test(char)) {
      return false;
    }
    if ('<>|"\'`\\|()[]{}'.includes(char)) {
      return false;
    }
  }
  return true;
}

function isSafeHttpsUrl(urlValue: unknown): boolean {
  if (typeof urlValue !== 'string') {
    return false;
  }
  if (!urlValue.startsWith('https://')) {
    return false;
  }
  if (!isMarkdownSafeUrlDestination(urlValue)) {
    return false;
  }
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    if (urlValue.includes('@')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function table(headers: string[], rows: string[][]): string {
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function selectedProductVerdict(pack: CiEvidencePack, platform: CiEvidencePackPlatform): string {
  const platformRecord = pack.platforms.find((item) => item.platform === platform);
  if (platformRecord?.selectedAttemptId === undefined) {
    return 'not_evaluated';
  }
  const attempt = pack.attempts.find((item) => item.attemptId === platformRecord.selectedAttemptId);
  if (attempt === undefined) {
    return 'not_evaluated';
  }
  const listedVerdictEvidenceIds = attempt.evidenceIds.filter((evidenceId) => {
    const evidence = pack.evidence.find((item) => item.evidenceId === evidenceId);
    return (
      evidence?.kind === 'verdict' &&
      evidence.status === 'present' &&
      evidence.attemptId === attempt.attemptId &&
      evidence.platform === platform
    );
  });
  const matchingVerdicts = pack.verdicts.filter((item) => {
    if (!listedVerdictEvidenceIds.includes(item.evidenceId)) {
      return false;
    }
    return (
      item.platform === attempt.platform &&
      item.scenarioId === attempt.scenarioId &&
      item.runId === attempt.runId
    );
  });
  if (matchingVerdicts.length !== 1) {
    return 'not_evaluated';
  }
  return matchingVerdicts[0]?.status ?? 'not_evaluated';
}

function requestedTarget(item: CiEvidencePublicationRequestedItem): string {
  if (item.targetKind === 'pack_artifact') {
    return item.packArtifact;
  }
  return item.evidenceId;
}

function outcomeForRequest(
  receipt: CiEvidencePublicationReceipt,
  requestId: string,
): CiEvidencePublicationItemOutcome | undefined {
  return receipt.outcomes.find((outcome) => outcome.requestId === requestId);
}

function renderHttpsLink(label: string, urlValue: string): string {
  const safeLabel = escapeMarkdownPlain(label);
  return `[${safeLabel}](<${urlValue}>)`;
}

function renderAuthenticatedOutcome(
  target: string,
  outcome: CiEvidencePublicationItemOutcome | undefined,
): string {
  if (outcome === undefined) {
    return escapeMarkdownCell('unrequested');
  }
  if (outcome.status !== 'published') {
    return escapeMarkdownCell(`${outcome.status}: ${outcome.reason}`);
  }
  if (outcome.visibility !== 'public' && outcome.visibility !== 'restricted') {
    return escapeMarkdownCell(`published ${outcome.visibility}; no review link`);
  }
  if (!isSafeHttpsUrl(outcome.url)) {
    return escapeMarkdownCell('published; no usable review link');
  }
  return `${renderHttpsLink(target, outcome.url)} (${escapeMarkdownCell(outcome.visibility)})`;
}

function selectedAttemptIdFor(
  pack: CiEvidencePack,
  platform: CiEvidencePackPlatform,
): string | undefined {
  return pack.platforms.find((item) => item.platform === platform)?.selectedAttemptId;
}

function sortAttempts(attempts: readonly CiEvidencePackAttemptRecord[]): CiEvidencePackAttemptRecord[] {
  return [...attempts].sort((left, right) => {
    const platformCmp = compareUtf16(left.platform, right.platform);
    if (platformCmp !== 0) {
      return platformCmp;
    }
    const scenarioCmp = compareUtf16(left.scenarioId, right.scenarioId);
    if (scenarioCmp !== 0) {
      return scenarioCmp;
    }
    if (left.attemptNumber !== right.attemptNumber) {
      return left.attemptNumber - right.attemptNumber;
    }
    return compareUtf16(left.attemptId, right.attemptId);
  });
}

function sortRequestedItems(
  items: readonly CiEvidencePublicationRequestedItem[],
): CiEvidencePublicationRequestedItem[] {
  return [...items].sort((left, right) => compareUtf16(left.requestId, right.requestId));
}

function renderGateTable(gate: CiEvidenceGithubPublicationGateResult): string {
  const { pack, receipt, evaluation } = gate;
  return table(
    ['Field', 'Value'],
    [
      ['publication evidence gate', escapeMarkdownCell(evaluation.status)],
      ['source status', escapeMarkdownCell(pack.source.status)],
      ['live-proof-set status', escapeMarkdownCell(pack.liveProofSet.status)],
      ['pack mechanism', escapeMarkdownCell(pack.mechanismStatus)],
      ['two-platform evidence claim', escapeMarkdownCell(pack.twoPlatformClaim.status)],
      ['completeness', escapeMarkdownCell(pack.completeness.status)],
      ['assembly', escapeMarkdownCell(pack.assembly.status)],
      ['publication status', escapeMarkdownCell(receipt.publicationStatus)],
      ['comparison status', escapeMarkdownCell(pack.comparisonStatus)],
    ],
  );
}

function renderGateReasons(gate: CiEvidenceGithubPublicationGateResult): string | undefined {
  if (gate.evaluation.status !== 'failed') {
    return undefined;
  }
  const lines = ['## Gate reasons', ''];
  for (const reason of gate.evaluation.reasons) {
    lines.push(`- ${escapeMarkdownPlain(reason)}`);
  }
  return lines.join('\n');
}

function renderPlatformTable(pack: CiEvidencePack): string {
  const rows = PLATFORMS.map((platform) => {
    const record = pack.platforms.find((item) => item.platform === platform);
    const selectedAttemptId = record?.selectedAttemptId;
    return [
      escapeMarkdownCell(platform),
      escapeMarkdownCell(record?.authorityStatus ?? ''),
      escapeMarkdownCell(record?.evaluationStatus ?? ''),
      escapeMarkdownCell(selectedAttemptId ?? ''),
      escapeMarkdownCell(selectedProductVerdict(pack, platform)),
    ];
  });
  return table(
    ['Platform', 'Authority', 'Evaluation', 'Selected attempt', 'Selected product verdict'],
    rows,
  );
}

function renderAttemptsTable(pack: CiEvidencePack): string {
  const rows = sortAttempts(pack.attempts).map((attempt) => {
    const selectedId = selectedAttemptIdFor(pack, attempt.platform);
    const selected = selectedId !== undefined && selectedId === attempt.attemptId ? 'selected' : '';
    return [
      escapeMarkdownCell(attempt.platform),
      escapeMarkdownCell(attempt.scenarioId),
      escapeMarkdownCell(String(attempt.attemptNumber)),
      escapeMarkdownCell(attempt.attemptId),
      escapeMarkdownCell(attempt.status),
      escapeMarkdownCell(selected),
    ];
  });
  return table(
    ['Platform', 'Scenario', 'Attempt number', 'Attempt id', 'Status', 'Selected'],
    rows,
  );
}

function renderLinksTable(receipt: CiEvidencePublicationReceipt): string {
  const rows = sortRequestedItems(receipt.requestedItems).map((item) => {
    const target = requestedTarget(item);
    const outcome = outcomeForRequest(receipt, item.requestId);
    return [
      escapeMarkdownCell(item.requestId),
      escapeMarkdownCell(target),
      renderAuthenticatedOutcome(target, outcome),
    ];
  });
  return table(['Request id', 'Target', 'Outcome'], rows);
}

function renderProofBoundaries(): string {
  return [
    'Publication links and the publication evidence gate do not prove product, runtime, comparison, release, deployment, or merge acceptance.',
    'Artifact presence proves only the artifact obligation for that evidence item.',
    'Restricted links require authenticated access and are not public proof.',
  ].join('\n');
}

function assembleMarkdown(gate: CiEvidenceGithubPublicationGateResult): string {
  const sections = ['# CI evidence review', renderGateTable(gate)];
  const reasons = renderGateReasons(gate);
  if (reasons !== undefined) {
    sections.push(reasons);
  }
  sections.push(renderPlatformTable(gate.pack));
  sections.push(renderAttemptsTable(gate.pack));
  sections.push(renderLinksTable(gate.receipt));
  sections.push(renderProofBoundaries());
  return `${sections.join('\n\n')}\n`;
}

export function buildCiEvidenceGithubPublicationReport(
  exactPackBytes: Uint8Array,
  publicationFacts: unknown,
): CiEvidenceGithubPublicationReport {
  const gate = evaluateCiEvidenceGithubPublicationGate(exactPackBytes, publicationFacts);
  return {
    gate,
    markdown: assembleMarkdown(gate),
  };
}
