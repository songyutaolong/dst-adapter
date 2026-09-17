export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/i, '').split(/[-+]/)[0]
    .split('.')
    .map((part) => Number(part) || 0)
  const leftParts = parse(left)
  const rightParts = parse(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
