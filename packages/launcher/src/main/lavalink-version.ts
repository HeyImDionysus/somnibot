export const LAVALINK_VERSION = '4.2.2';

export const LAVALINK_JAR_URL =
  `https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar`;

export function isCurrentLavalinkVersion(receipt: string): boolean {
  return receipt.trim() === LAVALINK_VERSION;
}
