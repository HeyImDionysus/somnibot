import { Folder, Hash, Megaphone, Volume2 } from 'lucide-react';
import { CHANNEL_TYPE } from './channel-picker-model';

export function ChannelIcon({ type }: { readonly type: number }) {
  const className = 'shrink-0 text-discord-text-muted';
  switch (type) {
    case CHANNEL_TYPE.GUILD_VOICE:
    case CHANNEL_TYPE.GUILD_STAGE_VOICE:
      return <Volume2 size={14} className={className} aria-hidden="true" />;
    case CHANNEL_TYPE.GUILD_ANNOUNCEMENT:
      return <Megaphone size={14} className={className} aria-hidden="true" />;
    case CHANNEL_TYPE.GUILD_CATEGORY:
      return <Folder size={14} className={className} aria-hidden="true" />;
    default:
      return <Hash size={14} className={className} aria-hidden="true" />;
  }
}
