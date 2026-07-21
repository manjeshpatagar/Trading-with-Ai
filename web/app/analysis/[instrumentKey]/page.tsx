import { StockAnalysisWorkspace } from '../../../components/stock-analysis-workspace';

export default async function AnalysisPage({ params }: { params: Promise<{ instrumentKey: string }> }) {
  const { instrumentKey } = await params;
  return <StockAnalysisWorkspace instrumentKey={decodeURIComponent(instrumentKey)} />;
}
