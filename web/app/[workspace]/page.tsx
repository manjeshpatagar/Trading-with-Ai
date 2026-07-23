import { TradingWorkspace } from '../../components/trading-workspace';
import { redirect } from 'next/navigation';

const workspaces = new Set(['scanner', 'top-buy', 'top-sell', 'ai-signal-history', 'settings']);
export default async function WorkspacePage({ params }: { params: Promise<{ workspace: string }> }) { const { workspace } = await params; if (!workspaces.has(workspace)) redirect('/'); return <TradingWorkspace />; }
