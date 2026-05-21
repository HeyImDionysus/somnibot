'use client';

import { Store } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useGuildConfig, useUpdateGuildConfig } from '@/hooks/use-guild-config';
import { toast } from '@/hooks/use-toast';

// ── Page ───────────────────────────────────────────────────

export default function MarketPage() {
  const { data: config, isLoading } = useGuildConfig();
  const updateConfig = useUpdateGuildConfig();

  const handleConfigChange = async (key: string, value: boolean | number) => {
    try {
      await updateConfig.mutateAsync({ [key]: value });
      toast({ title: 'Saved', description: 'Market config updated.', variant: 'success' });
    } catch {
      toast({ title: 'Error', description: 'Failed to save config.', variant: 'error' });
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">🏪 Player Market</h1>
        <p className="text-muted-foreground">Configure the peer-to-peer item marketplace.</p>
      </div>

      <Card className="p-6 space-y-6">
        <h2 className="text-lg font-semibold">Market Settings</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Market Enabled</Label>
              <p className="text-sm text-muted-foreground">Allow players to list and buy items from each other.</p>
            </div>
            <input
              type="checkbox"
              checked={config?.economy_market_enabled ?? false}
              onChange={(e) => handleConfigChange('economy_market_enabled', e.target.checked)}
              className="toggle"
            />
          </div>

          <div>
            <Label>Market Fee (%)</Label>
            <p className="text-sm text-muted-foreground mb-1">Percentage taken from each sale as a currency sink.</p>
            <Input
              type="number"
              value={config?.economy_market_fee_pct ?? 5}
              onChange={(e) => handleConfigChange('economy_market_fee_pct', parseInt(e.target.value) || 5)}
              min={0}
              max={50}
            />
          </div>

          <div>
            <Label>Listing Duration (days)</Label>
            <p className="text-sm text-muted-foreground mb-1">How long listings remain active before expiring.</p>
            <Input
              type="number"
              value={config?.economy_market_listing_days ?? 7}
              onChange={(e) => handleConfigChange('economy_market_listing_days', parseInt(e.target.value) || 7)}
              min={1}
              max={30}
            />
          </div>

          <div>
            <Label>Max Listings per Player</Label>
            <p className="text-sm text-muted-foreground mb-1">Maximum active listings a player can have.</p>
            <Input
              type="number"
              value={config?.economy_market_max_listings ?? 10}
              onChange={(e) => handleConfigChange('economy_market_max_listings', parseInt(e.target.value) || 10)}
              min={1}
              max={50}
            />
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Store className="h-8 w-8" />
          <div>
            <p className="font-medium">Market activity is managed by players in Discord</p>
            <p className="text-sm">Use <code>/market browse</code>, <code>/market list</code>, and <code>/market buy</code> commands.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
