export function clearResolvedDestinationError(
  currentError: string | null,
  channelId: string | null,
  authoritative: boolean,
): string | null {
  return channelId && authoritative ? null : currentError;
}
