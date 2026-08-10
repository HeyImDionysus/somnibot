import { redirect } from 'next/navigation';

export default function ChannelsPage() {
  redirect('/server-setup?step=3');
}
