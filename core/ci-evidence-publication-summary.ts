const {
  CiEvidencePublicationReceiptError,
  assertCiEvidencePublicationReceiptForExactPackBytes,
} = require('./ci-evidence-publication-receipt');
import type { CiEvidencePack, CiEvidencePackPlatform } from './ci-evidence-pack';
import type {
  CiEvidencePublicationItemOutcome,
  CiEvidencePublicationReceipt,
  CiEvidencePublicationRequestedItem,
} from './ci-evidence-publication-receipt';

function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    cloned[key] = cloneJsonValue((value as Record<string, unknown>)[key]);
  }
  return cloned as T;
}

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
    .replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1 @ $2');
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

function renderHttpsLink(label: string, urlValue: unknown): string {
  if (typeof urlValue !== 'string' || !isSafeHttpsUrl(urlValue)) {
    return escapeMarkdownCell('published; no usable public review link');
  }
  const safeLabel = escapeMarkdownPlain(label);
  return `[${safeLabel}](<${urlValue}>)`;
}

function assertRendererSafePublishedUrls(receipt: CiEvidencePublicationReceipt): void {
  for (const outcome of receipt.outcomes) {
    if (outcome.status !== 'published') {
      continue;
    }
    if (!isSafeHttpsUrl(outcome.url)) {
      throw new CiEvidencePublicationReceiptError(
        'published outcome lacks a renderer-safe HTTPS URL',
      );
    }
  }
}

function table(headers: string[], rows: string[][]): string {
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function selectedProductVerdict(
  pack: CiEvidencePack,
  platform: CiEvidencePackPlatform,
): string {
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

function sortEvidence(pack: CiEvidencePack, platform: CiEvidencePackPlatform) {
  const requiredOrder = new Map(
    [...pack.requiredEvidenceKinds].sort(compareUtf16).map((kind, index) => [kind, index]),
  );
  const selectedId = pack.platforms.find((item) => item.platform === platform)?.selectedAttemptId;
  const rows = pack.evidence.filter((item) => item.platform === platform);
  return [...rows].sort((left, right) => {
    const leftSelected = selectedId !== undefined && left.attemptId === selectedId;
    const rightSelected = selectedId !== undefined && right.attemptId === selectedId;
    if (leftSelected !== rightSelected) {
      return leftSelected ? -1 : 1;
    }
    const attemptCmp = compareUtf16(left.attemptId, right.attemptId);
    if (attemptCmp !== 0) {
      return attemptCmp;
    }
    const leftRequired = requiredOrder.get(left.kind);
    const rightRequired = requiredOrder.get(right.kind);
    const leftRank = leftRequired !== undefined ? leftRequired : 1000;
    const rightRank = rightRequired !== undefined ? rightRequired : 1000;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    if (left.kind !== right.kind) {
      return compareUtf16(left.kind, right.kind);
    }
    return compareUtf16(left.evidenceId, right.evidenceId);
  });
}

function outcomeForEvidence(
  receipt: CiEvidencePublicationReceipt,
  evidenceId: string,
): {
  item?: CiEvidencePublicationRequestedItem | undefined;
  outcome?: CiEvidencePublicationItemOutcome | undefined;
} {
  const item = receipt.requestedItems.find(
    (requested) => requested.targetKind === 'evidence' && requested.evidenceId === evidenceId,
  );
  if (item === undefined) {
    return {};
  }
  const outcome = receipt.outcomes.find((entry) => entry.requestId === item.requestId);
  const matched: {
    item?: CiEvidencePublicationRequestedItem | undefined;
    outcome?: CiEvidencePublicationItemOutcome | undefined;
  } = { item };
  if (outcome !== undefined) {
    matched.outcome = outcome;
  }
  return matched;
}

function renderPublicationStatus(
  outcome: CiEvidencePublicationItemOutcome | undefined,
  evidenceIdOrArtifact: string,
): string {
  if (outcome === undefined) {
    return escapeMarkdownCell('unrequested');
  }
  if (outcome.status !== 'published') {
    return escapeMarkdownCell(`${outcome.status}: ${outcome.reason}`);
  }
  if (outcome.visibility === 'restricted') {
    return escapeMarkdownCell('published (restricted); no public review link');
  }
  if (outcome.visibility !== 'public') {
    return escapeMarkdownCell(`published ${outcome.visibility}; no public review link`);
  }
  if (!isSafeHttpsUrl(outcome.url)) {
    return escapeMarkdownCell('published; no usable public review link');
  }
  return renderHttpsLink(evidenceIdOrArtifact, outcome.url);
}

function renderEvidenceCell(
  packEvidenceStatus: string,
  evidenceId: string,
  outcome: CiEvidencePublicationItemOutcome | undefined,
): string {
  if (packEvidenceStatus !== 'present') {
    if (outcome === undefined) {
      return escapeMarkdownCell(`${packEvidenceStatus}; unrequested`);
    }
    if (outcome.status === 'published') {
      return escapeMarkdownCell(`${packEvidenceStatus}; published outcome ignored for non-present evidence`);
    }
    return escapeMarkdownCell(`${packEvidenceStatus}; ${outcome.status}: ${outcome.reason}`);
  }
  return renderPublicationStatus(outcome, evidenceId);
}

function attemptIdentityLabel(
  pack: CiEvidencePack,
  attemptId: string,
  selectedId: string | undefined,
): string {
  const attempt = pack.attempts.find((item) => item.attemptId === attemptId);
  const selected = selectedId !== undefined && attemptId === selectedId ? 'selected' : 'retained';
  if (attempt === undefined) {
    return `${attemptId} (${selected}; unknown)`;
  }
  return `${attemptId} (${selected}; ${attempt.status})`;
}

function renderPlatformSection(
  pack: CiEvidencePack,
  receipt: CiEvidencePublicationReceipt,
  platform: CiEvidencePackPlatform,
): string {
  const heading = platform === 'android' ? '## Android evidence' : '## iOS evidence';
  const record = pack.platforms.find((item) => item.platform === platform);
  const selectedAttemptId = record?.selectedAttemptId;
  const selectedAttempt = pack.attempts.find((item) => item.attemptId === selectedAttemptId);
  const selectedIdentity =
    selectedAttempt === undefined
      ? 'none'
      : `${selectedAttempt.attemptId} (${selectedAttempt.status})`;
  const productVerdict = selectedProductVerdict(pack, platform);
  const authority = record?.authorityStatus ?? 'missing';
  const evaluation = record?.evaluationStatus ?? 'missing';
  const evidenceRows = sortEvidence(pack, platform).map((evidence) => {
    const { outcome } = outcomeForEvidence(receipt, evidence.evidenceId);
    return [
      escapeMarkdownCell(evidence.kind),
      escapeMarkdownCell(evidence.evidenceId),
      escapeMarkdownCell(attemptIdentityLabel(pack, evidence.attemptId, selectedAttemptId)),
      escapeMarkdownCell(evidence.status),
      renderEvidenceCell(evidence.status, evidence.evidenceId, outcome),
    ];
  });
  const identityTable = table(
    ['Field', 'Value'],
    [
      ['authorityStatus', escapeMarkdownCell(authority)],
      ['evaluationStatus', escapeMarkdownCell(evaluation)],
      ['selectedAttempt', escapeMarkdownCell(selectedIdentity)],
      ['selectedProductVerdict', escapeMarkdownCell(productVerdict)],
    ],
  );
  const evidenceTable =
    evidenceRows.length === 0
      ? table(
          ['Kind', 'Evidence id', 'Attempt', 'Pack status', 'Publication'],
          [[escapeMarkdownCell('none'), '-', '-', '-', escapeMarkdownCell('no evidence rows')]],
        )
      : table(['Kind', 'Evidence id', 'Attempt', 'Pack status', 'Publication'], evidenceRows);
  return [heading, '', identityTable, '', evidenceTable].join('\n');
}

function renderAttempts(pack: CiEvidencePack): string {
  const sorted = [...pack.attempts].sort((left, right) => {
    if (left.platform !== right.platform) {
      return left.platform === 'android' ? -1 : 1;
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
  const selected = new Set(
    pack.platforms
      .map((record) => record.selectedAttemptId)
      .filter((value): value is string => value !== undefined),
  );
  const rows = sorted.map((attempt) => [
    escapeMarkdownCell(attempt.platform),
    escapeMarkdownCell(attempt.scenarioId),
    String(attempt.attemptNumber),
    escapeMarkdownCell(attempt.attemptId),
    escapeMarkdownCell(attempt.status),
    selected.has(attempt.attemptId) ? 'selected' : '',
  ]);
  return [
    '## Attempts',
    '',
    table(
      ['Platform', 'Scenario', 'Attempt number', 'Attempt id', 'Status', 'Selected'],
      rows,
    ),
  ].join('\n');
}

function publicationOutcomeSuppliesUsableLinkForAudience(
  outcome: CiEvidencePublicationItemOutcome | undefined,
  audience: CiEvidencePublicationAudience,
): boolean {
  if (outcome === undefined || outcome.status !== 'published' || !isSafeHttpsUrl(outcome.url)) {
    return false;
  }
  if (audience === 'authenticated_reviewer') {
    return outcome.visibility === 'public' || outcome.visibility === 'restricted';
  }
  return outcome.visibility === 'public';
}

function unpublishedRows(
  pack: CiEvidencePack,
  receipt: CiEvidencePublicationReceipt,
  audience: CiEvidencePublicationAudience,
): string[][] {
  const rows: string[][] = [];
  const itemsById = new Map(receipt.requestedItems.map((item) => [item.requestId, item]));
  const outcomes = [...receipt.outcomes].sort((left, right) =>
    compareUtf16(left.requestId, right.requestId),
  );
  for (const outcome of outcomes) {
    const item = itemsById.get(outcome.requestId);
    let target = outcome.requestId;
    if (item !== undefined) {
      if (item.targetKind === 'pack_artifact') {
        target = item.packArtifact;
      } else {
        target = item.evidenceId;
      }
    }
    const evidenceRecord =
      item?.targetKind === 'evidence'
        ? pack.evidence.find((entry) => entry.evidenceId === item.evidenceId)
        : undefined;
    const nonPresentPublished =
      item?.targetKind === 'evidence' &&
      evidenceRecord !== undefined &&
      evidenceRecord.status !== 'present' &&
      outcome.status === 'published';
    const lacksUsableLink = !publicationOutcomeSuppliesUsableLinkForAudience(outcome, audience);
    if (!lacksUsableLink && !nonPresentPublished) {
      continue;
    }
    let statusLabel: string = outcome.status;
    let reason: string;
    if (nonPresentPublished) {
      statusLabel = 'published outcome ignored';
      reason = 'no authoritative public link for non-present evidence';
    } else if (outcome.status === 'published' && outcome.visibility === 'restricted') {
      statusLabel = 'published (restricted)';
      reason = 'restricted; no public review link';
    } else if (outcome.status === 'published') {
      statusLabel = 'published; no usable public review link';
      reason = 'published outcome lacks a usable public review link';
    } else {
      reason = outcome.reason;
    }
    rows.push([
      escapeMarkdownCell(outcome.requestId),
      escapeMarkdownCell(String(target)),
      escapeMarkdownCell(statusLabel),
      escapeMarkdownCell(reason),
    ]);
  }

  const obligationRows: string[][] = [];
  for (const platform of ['android', 'ios'] as const) {
    const requiredKinds = [...pack.requiredEvidenceKinds].sort(compareUtf16);
    for (const kind of requiredKinds) {
      const selectedAttemptId = pack.platforms.find((item) => item.platform === platform)
        ?.selectedAttemptId;
      const selectedMatches = pack.evidence.filter(
        (evidence) =>
          evidence.platform === platform &&
          evidence.kind === kind &&
          selectedAttemptId !== undefined &&
          evidence.attemptId === selectedAttemptId,
      );
      const publishedPresent = selectedMatches.some((evidence) => {
        if (evidence.status !== 'present') {
          return false;
        }
        const { outcome } = outcomeForEvidence(receipt, evidence.evidenceId);
        return publicationOutcomeSuppliesUsableLinkForAudience(outcome, audience);
      });
      if (publishedPresent) {
        continue;
      }
      let packStatus: string;
      if (selectedAttemptId === undefined) {
        packStatus = 'no selected attempt';
      } else if (selectedMatches.length === 0) {
        packStatus = 'missing from pack';
      } else {
        packStatus = [...selectedMatches.map((item) => item.status)].sort(compareUtf16).join(',');
      }
      obligationRows.push([
        escapeMarkdownCell(`${platform}:${kind}`),
        escapeMarkdownCell(platform),
        escapeMarkdownCell(packStatus),
        escapeMarkdownCell('required platform+kind obligation lacks a published link'),
      ]);
    }
  }
  const mandatoryPackArtifacts = ['ci_evidence_pack', 'live_proof_set'] as const;
  for (const packArtifact of mandatoryPackArtifacts) {
    const item = receipt.requestedItems.find(
      (requested) =>
        requested.targetKind === 'pack_artifact' && requested.packArtifact === packArtifact,
    );
    if (item !== undefined) {
      const outcome = receipt.outcomes.find((entry) => entry.requestId === item.requestId);
      if (outcome !== undefined) {
        continue;
      }
      obligationRows.push([
        escapeMarkdownCell(packArtifact),
        escapeMarkdownCell(packArtifact),
        escapeMarkdownCell('requested; no publication outcome'),
        escapeMarkdownCell('mandatory artifact lacks a published public link'),
      ]);
      continue;
    }
    obligationRows.push([
      escapeMarkdownCell(packArtifact),
      escapeMarkdownCell(packArtifact),
      escapeMarkdownCell('unrequested'),
      escapeMarkdownCell('mandatory artifact lacks a published public link'),
    ]);
  }

  obligationRows.sort((left, right) => {
    const itemCmp = compareUtf16(left[0] ?? '', right[0] ?? '');
    if (itemCmp !== 0) {
      return itemCmp;
    }
    return compareUtf16(left[1] ?? '', right[1] ?? '');
  });
  rows.sort((left, right) => {
    const itemCmp = compareUtf16(left[0] ?? '', right[0] ?? '');
    if (itemCmp !== 0) {
      return itemCmp;
    }
    return compareUtf16(left[1] ?? '', right[1] ?? '');
  });
  return [...rows, ...obligationRows];
}

function packArtifactPublication(
  receipt: CiEvidencePublicationReceipt,
  packArtifact: 'ci_evidence_pack' | 'live_proof_set',
): string {
  const item = receipt.requestedItems.find(
    (requested) =>
      requested.targetKind === 'pack_artifact' && requested.packArtifact === packArtifact,
  );
  if (item === undefined) {
    return escapeMarkdownCell('unrequested');
  }
  const outcome = receipt.outcomes.find((entry) => entry.requestId === item.requestId);
  if (outcome === undefined) {
    return escapeMarkdownCell('requested; no publication outcome');
  }
  return renderPublicationStatus(outcome, packArtifact);
}

function canonicalJoin(values: readonly string[]): string {
  return [...values].sort(compareUtf16).join(', ');
}

function cloneExactPackBytes(exactPackBytes: Uint8Array): Uint8Array {
  return Uint8Array.from(exactPackBytes);
}

export type CiEvidencePublicationAudience = 'public' | 'authenticated_reviewer';

export interface CiEvidencePublicationSummaryEvaluationOptions {
  audience?: CiEvidencePublicationAudience;
}

export type CiEvidencePublicationSummaryEvaluation =
  | {
      status: 'passed';
      reasons: [];
    }
  | {
      status: 'failed';
      reasons: string[];
    };

function prepareCiEvidencePublicationSummaryInputs(
  packInput: CiEvidencePack,
  receiptInput: CiEvidencePublicationReceipt,
  exactPackBytesInput: Uint8Array,
): {
  pack: CiEvidencePack;
  receipt: CiEvidencePublicationReceipt;
} {
  const pack = cloneJsonValue(packInput);
  const receipt = cloneJsonValue(receiptInput);
  const exactPackBytes = cloneExactPackBytes(exactPackBytesInput);
  assertCiEvidencePublicationReceiptForExactPackBytes(receipt, pack, exactPackBytes);
  assertRendererSafePublishedUrls(receipt);
  return { pack, receipt };
}

function evaluatePreparedPublicationSummary(
  pack: CiEvidencePack,
  receipt: CiEvidencePublicationReceipt,
  audience: CiEvidencePublicationAudience,
): CiEvidencePublicationSummaryEvaluation {
  const unpublishedCount = unpublishedRows(pack, receipt, audience).length;
  const reasons: string[] = [];
  if (receipt.publicationStatus !== 'published') {
    reasons.push(`publicationStatus is ${receipt.publicationStatus}`);
  }
  if (unpublishedCount > 0) {
    const linkKind =
      audience === 'authenticated_reviewer'
        ? 'usable authenticated-reviewer link'
        : 'usable public link';
    reasons.push(
      `${unpublishedCount} publication or required-evidence obligation(s) lack a ${linkKind}`,
    );
  }
  if (reasons.length === 0) {
    return { status: 'passed', reasons: [] };
  }
  return { status: 'failed', reasons };
}

function evaluateCiEvidencePublicationSummary(
  packInput: CiEvidencePack,
  receiptInput: CiEvidencePublicationReceipt,
  exactPackBytesInput: Uint8Array,
  options?: CiEvidencePublicationSummaryEvaluationOptions,
): CiEvidencePublicationSummaryEvaluation {
  const audience = options?.audience ?? 'public';
  const { pack, receipt } = prepareCiEvidencePublicationSummaryInputs(
    packInput,
    receiptInput,
    exactPackBytesInput,
  );
  return evaluatePreparedPublicationSummary(pack, receipt, audience);
}

function renderCiEvidencePublicationSummary(
  packInput: CiEvidencePack,
  receiptInput: CiEvidencePublicationReceipt,
  exactPackBytesInput: Uint8Array,
): string {
  const { pack, receipt } = prepareCiEvidencePublicationSummaryInputs(
    packInput,
    receiptInput,
    exactPackBytesInput,
  );
  const evaluation = evaluatePreparedPublicationSummary(pack, receipt, 'public');
  const evidenceGateReasonsSection =
    evaluation.reasons.length === 0
      ? escapeMarkdownPlain('none')
      : evaluation.reasons.map((reason) => `- ${escapeMarkdownPlain(reason)}`).join('\n');

  const androidVerdict = selectedProductVerdict(pack, 'android');
  const iosVerdict = selectedProductVerdict(pack, 'ios');
  const distinct = table(
    ['Plane', 'Status'],
    [
      ['pack mechanism', escapeMarkdownCell(pack.mechanismStatus)],
      ['two-platform evidence claim', escapeMarkdownCell(pack.twoPlatformClaim.status)],
      ['comparison', escapeMarkdownCell(pack.comparisonStatus)],
      ['completeness', escapeMarkdownCell(pack.completeness.status)],
      ['assembly', escapeMarkdownCell(pack.assembly.status)],
      ['Android selected product verdict', escapeMarkdownCell(androidVerdict)],
      ['iOS selected product verdict', escapeMarkdownCell(iosVerdict)],
      ['publication', escapeMarkdownCell(receipt.publicationStatus)],
      ['publication evidence gate', escapeMarkdownCell(evaluation.status)],
    ],
  );

  const packIdentity = table(
    ['Field', 'Value'],
    [
      ['packId', escapeMarkdownCell(pack.packId)],
      ['schemaVersion', escapeMarkdownCell(pack.schemaVersion)],
      ['source.status', escapeMarkdownCell(pack.source.status)],
      ['liveProofSet.status', escapeMarkdownCell(pack.liveProofSet.status)],
      ['requiredPlatforms', escapeMarkdownCell(canonicalJoin(pack.requiredPlatforms))],
      ['requiredEvidenceKinds', escapeMarkdownCell(canonicalJoin(pack.requiredEvidenceKinds))],
      ['packSha256', escapeMarkdownCell(receipt.pack.sha256)],
      ['packByteSize', escapeMarkdownCell(String(receipt.pack.byteSize))],
    ],
  );

  const publicationIdentity = table(
    ['Field', 'Value'],
    [
      ['receiptId', escapeMarkdownCell(receipt.receiptId)],
      ['createdAt', escapeMarkdownCell(receipt.createdAt)],
      ['publisher.providerId', escapeMarkdownCell(receipt.publisher.providerId)],
      ['publisher.providerKind', escapeMarkdownCell(receipt.publisher.providerKind)],
      ['publisher.runId', escapeMarkdownCell(receipt.publisher.runId)],
      ['publicationStatus', escapeMarkdownCell(receipt.publicationStatus)],
      ['ci_evidence_pack', packArtifactPublication(receipt, 'ci_evidence_pack')],
      ['live_proof_set', packArtifactPublication(receipt, 'live_proof_set')],
    ],
  );

  const unpublished = unpublishedRows(pack, receipt, 'public');
  const unpublishedSection =
    unpublished.length === 0
      ? table(
          ['Item', 'Target', 'Status', 'Reason'],
          [[escapeMarkdownCell('none'), '-', '-', escapeMarkdownCell('all requested published obligations have links')]],
        )
      : table(['Item', 'Target', 'Status', 'Reason'], unpublished);

  const guardrails = [
    'Publication success does not prove mechanism success.',
    'Publication success does not prove two-platform evidence success.',
    'Publication success does not prove product behavior.',
    'Publication success does not prove comparison.',
    'Publication success does not prove completeness.',
    'Publication success does not prove assembly.',
    'Publication success does not prove release acceptance.',
    'Publication success does not prove runtime acceptance.',
    'Publication success does not prove deployment.',
  ].join('\n');

  const markdown = [
    '# CI evidence publication',
    '',
    '## Distinct statuses',
    '',
    distinct,
    '',
    '## Pack identity',
    '',
    packIdentity,
    '',
    '## Publication identity',
    '',
    publicationIdentity,
    '',
    renderPlatformSection(pack, receipt, 'android'),
    '',
    renderPlatformSection(pack, receipt, 'ios'),
    '',
    renderAttempts(pack),
    '',
    '## Unpublished and missing evidence',
    '',
    unpublishedSection,
    '',
    '## Publication evidence gate',
    '',
    evidenceGateReasonsSection,
    '',
    '## Guardrails',
    '',
    guardrails,
    '',
  ].join('\n');

  if (markdown.includes('\r')) {
    throw new CiEvidencePublicationReceiptError('summary must use LF only');
  }
  const trimmed = markdown.replace(/[ \t]+$/gm, '');
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

export { evaluateCiEvidencePublicationSummary, renderCiEvidencePublicationSummary };
