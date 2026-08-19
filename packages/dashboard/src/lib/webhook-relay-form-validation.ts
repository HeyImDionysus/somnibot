const DESTINATION_ERROR = 'Choose a destination from a fresh live Discord snapshot.';

export function destinationValidationError(
  channelId: string | null,
  authoritative: boolean,
): string | null {
  return channelId && authoritative ? null : DESTINATION_ERROR;
}

export function clearResolvedDestinationError(
  currentError: string | null,
  channelId: string | null,
  authoritative: boolean,
): string | null {
  return channelId && authoritative ? null : currentError;
}
