export type ReactionRoleMessageReference =
  | {
      readonly kind: 'valid';
      readonly channelId: string;
      readonly messageId: string;
    }
  | { readonly kind: 'invalid' };

const MESSAGE_LINK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d{17,20}\/(\d{17,20})\/(\d{17,20})(?:[/?#].*)?$/;

export function parseReactionRoleMessageReference(value: string): ReactionRoleMessageReference {
  const match = MESSAGE_LINK.exec(value.trim());
  if (!match) return { kind: 'invalid' };

  const [, channelId, messageId] = match;
  if (!channelId || !messageId) return { kind: 'invalid' };
  return { kind: 'valid', channelId, messageId };
}
