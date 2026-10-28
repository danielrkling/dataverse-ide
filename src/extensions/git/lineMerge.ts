/*
 * Line-level diff and selective-merge used by the inline "stage/discard
 * selected lines" commands.
 *
 * The diff is anchored to a base text (usually HEAD) and a current text
 * (usually the working tree). Each change is a replacement of a base line
 * range with a current line range. A selection predicate then decides which
 * replacements carry over when producing one of:
 *
 *   - staged content: base with only the selected replacements applied
 *     ("stage those lines")
 *   - worktree content: base with only the unselected replacements applied
 *     ("discard those lines")
 */

export type DiffReplacement = {
  /** Zero-based start line in the base lines. */
  baseStart: number
  /** Number of base lines replaced. */
  baseCount: number
  /** Zero-based start line in the current lines. */
  currentStart: number
  /** Number of current lines replacing it. */
  currentCount: number
}

const LCS_BUDGET = 1_600 // max lines per side of the DP middle region

export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }

  return text.split(/\r\n|\r|\n/)
}

export function detectLineDiff(
  baseText: string,
  currentText: string,
): DiffReplacement[] {
  if (baseText === currentText) {
    return []
  }

  let base = splitLines(baseText)
  let current = splitLines(currentText)

  const anchorCount = Math.min(base.length, current.length)

  let prefix = 0

  while (prefix < anchorCount && base[prefix] === current[prefix]) {
    prefix += 1
  }

  let suffix = 0

  while (
    suffix < anchorCount - prefix &&
    base[base.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const baseMid = base.slice(prefix, base.length - suffix)
  const currentMid = current.slice(prefix, current.length - suffix)

  const replacements: DiffReplacement[] = []

  if (baseMid.length === 0 && currentMid.length === 0) {
    return []
  }

  const middleReplacements =
    baseMid.length <= LCS_BUDGET && currentMid.length <= LCS_BUDGET
      ? diffMiddle(baseMid, currentMid, prefix)
      : [
          {
            baseStart: prefix,
            baseCount: baseMid.length,
            currentStart: prefix,
            currentCount: currentMid.length,
          } satisfies DiffReplacement,
        ]

  return [...replacements, ...middleReplacements]
}

/**
 * Longest-common-subsequence diff over the middle region. The regions are
 * capped upstream (see LCS_BUDGET); anything larger degrades to one big
 * replacement rather than stalling big files.
 */
function diffMiddle(baseMid: string[], currentMid: string[], offset: number): DiffReplacement[] {
  const opReplacement = {
    baseStart: 0,
    baseCount: 0,
    currentStart: 0,
    currentCount: 0,
  }

  const rows = baseMid.length
  const cols = currentMid.length

  const lengths: Uint32Array = new Uint32Array((rows + 1) * (cols + 1))

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      if (baseMid[i] === currentMid[j]) {
        lengths[i * (cols + 1) + j] =
          lengths[(i + 1) * (cols + 1) + j + 1] + 1
      } else {
        lengths[i * (cols + 1) + j] = Math.max(
          lengths[(i + 1) * (cols + 1) + j],
          lengths[i * (cols + 1) + j + 1],
        )
      }
    }
  }

  const result: DiffReplacement[] = []

  let baseIndex = 0
  let currentIndex = 0

  const pushReplacement = (): void => {
    if (opReplacement.baseCount === 0 && opReplacement.currentCount === 0) {
      return
    }

    result.push({
      baseStart: offset + opReplacement.baseStart,
      baseCount: opReplacement.baseCount,
      currentStart: offset + opReplacement.currentStart,
      currentCount: opReplacement.currentCount,
    })

    opReplacement.baseStart = 0
    opReplacement.baseCount = 0
    opReplacement.currentStart = 0
    opReplacement.currentCount = 0
  }

  while (baseIndex < rows && currentIndex < cols) {
    if (baseMid[baseIndex] === currentMid[currentIndex]) {
      pushReplacement()
      baseIndex += 1
      currentIndex += 1
      continue
    }

    if (
      lengths[(baseIndex + 1) * (cols + 1) + currentIndex] >=
      lengths[baseIndex * (cols + 1) + currentIndex + 1]
    ) {
      if (opReplacement.baseCount === 0) {
        opReplacement.baseStart = baseIndex
        opReplacement.currentStart = currentIndex
      }

      opReplacement.baseCount += 1
      baseIndex += 1
    } else {
      if (opReplacement.baseCount === 0) {
        opReplacement.baseStart = baseIndex
        opReplacement.currentStart = currentIndex
      }

      opReplacement.currentCount += 1
      currentIndex += 1
    }
  }

  if (baseIndex < rows) {
    if (opReplacement.baseCount === 0) {
      opReplacement.baseStart = baseIndex
      opReplacement.currentStart = currentIndex
    }
    opReplacement.baseCount += rows - baseIndex
  } else if (currentIndex < cols) {
    if (opReplacement.baseCount === 0) {
      opReplacement.baseStart = baseIndex
      opReplacement.currentStart = currentIndex
    }
    opReplacement.currentCount += cols - currentIndex
  }

  pushReplacement()
  return result
}

function lineRangesOverlap(
  selection: { fromInclusive: number; toInclusive: number },
  start: number,
  count: number,
): boolean {
  const endInclusive = count === 0 ? start : start + count - 1

  return selection.fromInclusive <= endInclusive && start <= selection.toInclusive
}

/**
 * Decide whether a replacement intersects the selected line range. Deleted
 * (empty current) replacements are anchored to the corresponding base lines.
 */
export function replacementIntersectsSelection(
  replacement: DiffReplacement,
  selection: { fromInclusive: number; toInclusive: number },
): boolean {
  return (
    lineRangesOverlap(
      selection,
      replacement.currentStart,
      replacement.currentCount,
    ) ||
    lineRangesOverlap(
      selection,
      replacement.baseStart,
      replacement.baseCount,
    )
  )
}

type MergeMode = 'selected' | 'unselected'

/**
 * Apply the diff in a mode-sensitive way.
 *
 *   - mode "selected" produces "the base text plus exactly the lines the
 *     user selected" (used as the new staged content).
 *   - mode "unselected" produces "the base text plus exactly the lines the
 *     user did NOT select" (used as the new working-tree content when the
 *     selection is discarded).
 *
 * Pure insertions and pure deletions are honored line-by-line inside their
 * ranges, so selecting a subset of inserted lines stages/keeps only those
 * lines. Modified (replace) replacements are applied whole: splitting one
 * replacement per line would reintroduce the removed pairing.
 */
export function selectiveMerge(
  baseLines: string[],
  currentLines: string[],
  replacements: DiffReplacement[],
  lineEnding: string,
  selection: { fromInclusive: number; toInclusive: number },
  mode: MergeMode,
): string {
  const out: string[] = []

  const lineIsSelected = (lineIndex: number): boolean =>
    lineIndex >= selection.fromInclusive && lineIndex <= selection.toInclusive

  let baseCursor = 0

  for (const replacement of replacements) {
    while (baseCursor < replacement.baseStart) {
      out.push(baseLines[baseCursor])
      baseCursor += 1
    }

    const pureInsertion =
      replacement.baseCount === 0 && replacement.currentCount > 0
    const pureReplacement =
      replacement.baseCount > 0 && replacement.currentCount > 0

    for (let i = 0; i < replacement.baseCount; i += 1) {
      const baseIndex = replacement.baseStart + i
      const keepBaseLine =
        pureInsertion
          ? true
          : pureReplacement
            ? mode === 'unselected'
            : mode === 'selected'
              ? !lineIsSelected(baseIndex)
              : lineIsSelected(baseIndex)

      if (keepBaseLine) {
        out.push(baseLines[baseIndex])
      }
    }

    for (let i = 0; i < replacement.currentCount; i += 1) {
      const currentIndex = replacement.currentStart + i

      if (pureReplacement) {
        const applyCurrent = mode === 'selected'

        if (applyCurrent) {
          out.push(currentLines[currentIndex])
        }

        continue
      }

      const applyCurrent =
        mode === 'selected'
          ? lineIsSelected(currentIndex)
          : !lineIsSelected(currentIndex)

      if (applyCurrent) {
        out.push(currentLines[currentIndex])
      }
    }

    baseCursor = replacement.baseStart + replacement.baseCount
  }

  while (baseCursor < baseLines.length) {
    out.push(baseLines[baseCursor])
    baseCursor += 1
  }

  /*
   * Trailing newline preservation is automatic: when the base/current texts
   * ended in a newline, their split arrays ended with an empty string, which
   * is kept (or replaced) by the anchored ranges above.
   */
  return out.join(lineEnding)
}

/**
 * Selection range over the split line arrays (0-based); editor selections
 * are passed through undisturbed because their line numbers are 0-based.
 */
export function selectionLineRange(
  firstLine: number,
  lastLine: number,
): { fromInclusive: number; toInclusive: number } {
  return {
    fromInclusive: Math.max(0, firstLine),
    toInclusive: Math.max(0, lastLine),
  }
}
